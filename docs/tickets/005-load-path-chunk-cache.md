# 005 — Load path chunk cache
Phase: 0 (defect) · Tag: normal · Spec sections: §14.2, §18 · Follows: 003

## Goal

Make loading a build cost the same per chunk as saving one. Gate 3 passed byte-identical but took 518.9 s to load what took 68.2 s to save, over the same 70 chunks: 7.4 s per chunk down versus 0.97 s per chunk up. The cause is not Drive latency. `api_loadChunk` re-reads the entire build file from Drive and base64-encodes all of it on every single call, then returns one 100 KB slice and discards the rest. For the gate 3 build that is 364 MB read and encoded to deliver 5.2 MB, and it scales as the square of build size.

This ticket moves that work to where the save path already puts it: once, up front. No API shape changes, no spec change — §14.2 names `api_loadChunk(buildId, index)` but says nothing about how it reads, so this is a defect fix rather than a decision change.

## Current behavior

```javascript
function api_loadChunk(buildId, index) {
  var row = readBuildRow_(buildId);                                    // Sheet read
  var base64 = Utilities.base64Encode(readBuildFile_(row.build.driveFileId));  // full 5.2 MB read + 7 MB encode
  return base64.substr(index * KS_MAX_CHUNK_CHARS, KS_MAX_CHUNK_CHARS);        // returns 100 KB
}
```

`api_loadBuildInfo` already performs that same full encode in order to compute `totalChunks`, and then throws the result away. The expensive pass is already being paid for, once, in the right place.

## Requirements

### 1. `api_loadBuildInfo` populates the chunk cache

Keep the existing encode. Before returning, split the base64 string into `KS_MAX_CHUNK_CHARS` pieces and write them into `CacheService.getScriptCache()` under:

```
ks_dl_<buildId>_<updated>_<index>
```

`<updated>` is the `updated` value from the build's index row, so a re-saved build can never serve stale chunks from a previous revision. TTL 6 h, matching the upload cache in 003.

Write with `putAll` in batches rather than one `put` per key; seventy individual `put` calls is the same mistake in a different direction. Keep batches small enough to stay under the per-call payload cap, and fall through silently if a batch write fails — a failed cache write must degrade to slow reads, never to an error.

Return `{ meta, totalChunks, cacheKeyBase }` where `cacheKeyBase` is `ks_dl_<buildId>_<updated>`. The client passes it back on each `api_loadChunk` call so the server does not re-read the index row to reconstruct the key.

### 2. `api_loadChunk` reads the cache first

New order of operations:

1. Auth check, as now.
2. If `cacheKeyBase` was supplied, attempt `CacheService.getScriptCache().get(cacheKeyBase + '_' + index)`. On a hit, return it. No Sheet read, no Drive read.
3. On a miss — eviction, an expired TTL, or a client that called `api_loadChunk` without first calling `api_loadBuildInfo` — fall back to the current slow path: read the row, read the file, encode, slice, return. Re-populate that one key in the cache on the way out.
4. Keep `CHUNK_OUT_OF_RANGE` and `BUILD_NOT_FOUND` behavior unchanged.

Correctness never depends on the cache. A completely cold cache produces the same bytes, just slowly.

Signature becomes `api_loadChunk(buildId, index, cacheKeyBase)`. The third argument is optional; omitting it forces the slow path, which is what the eviction test in §4 relies on.

### 3. Client

`load.js` passes `cacheKeyBase` from the `api_loadBuildInfo` response through to every `api_loadChunk` call. No other change. Chunk size, ordering, and reassembly stay as they are.

### 4. The eviction fallback gets tested, and exercised

This branch will almost never run in production, which is exactly why it rots. Both of these are required:

**Unit test** — `tests/server-logic.test.js`, using the existing eval-sandbox harness. Stub `CacheService` so `get` returns `null` for one specific key and a known string for the others, stub `readBuildFile_` to return a fixed buffer, then assert that:

- a cache hit returns the cached chunk and never calls `readBuildFile_`;
- a cache miss on chunk N returns the correct slice, computed from the stubbed file, byte-identical to what the hit path would have returned;
- the miss path re-populates the key it missed;
- a `cacheKeyBase` of `null` always takes the slow path;
- a cache `get` that throws is treated as a miss, not an error.

The hit-path and miss-path chunks must be asserted equal to each other, not just individually correct. That equality is the property the whole design rests on.

**Deliberate live exercise** — extend the `?dev=gate3` harness with an `evict` parameter. `?dev=gate3&evict=17` runs the normal round trip, but after `api_loadBuildInfo` returns it calls a new owner-only `api_devEvictChunk_(cacheKeyBase, index)` to remove that one key, then loads as usual. The run must still PASS with matching digests, and the harness reports the per-chunk time for the evicted chunk alongside the others so the fallback's cost is visible. Run it once and record it.

### 5. Report per-chunk numbers, not totals

Totals hid this defect for a whole ticket; the per-chunk figures are what made it diagnosable. The `?dev=gate3` panel must report, for both directions:

| | value |
|---|---|
| chunk count | |
| per-chunk save: min / median / max | ms |
| per-chunk load: min / median / max | ms |
| save wall clock | s |
| load wall clock | s |
| cache hits / misses on load | |
| evicted-chunk load time (when `evict` is used) | ms |

Median, not mean — one slow outlier should not move the number that gets compared.

**The number that matters is median per-chunk load.** It should land within roughly 1.5× of median per-chunk save. If it does not, the diagnosis in this ticket was incomplete, and the Handoff must say so plainly and give the measured figures rather than reporting a smaller total and calling it fixed. A load that improves to 120 s while still costing 4 s per chunk is not this bug fixed; it is this bug plus another one.

### 6. Docs

- `docs/PHASE0_RESULTS.md`: update the gate 3 row with the post-fix numbers, keeping the original 518.9 s figure alongside as the before value.
- `docs/DEFERRED.md`: record the rejected direct-Drive-fetch optimization — fetching the `.ksb` in one request from the client using `ScriptApp.getOAuthToken()` would put load in the low single-digit seconds, but it hands a token carrying the full `drive` scope to a page whose JavaScript is served from a public CDN, which couples a repo compromise to a Drive compromise for every family member. Note that narrowing the manifest to `drive.file` is the prerequisite if load time ever becomes the binding constraint again, and that it changes the manifest and the threat model, so it needs an ADR rather than an implementation decision.
- `CHANGELOG.md`: the `005` entry.

## Out of scope

- Any change to the save path. It is already O(1) per chunk.
- Any change to `api_loadChunk`'s place in §14.2, chunk sizing, or the halving ladder.
- Batch-fetching several chunks per call. It would help, but it changes the API shape §14.2 locks, so it is a spec question, not a defect fix.
- The `drive.file` scope narrowing and the direct-fetch path. Recorded in `DEFERRED.md`, not built.
- `Updater.gs` and gate 6 — ticket 004, independent of this.

## Acceptance

- [ ] `npm test` and `npm run build` pass.
- [ ] The five eviction-fallback assertions in §4 exist and pass, including the hit-equals-miss equality.
- [ ] On the deployed stable URL, `?dev=gate3` reports PASS with matching SHA-256 digests, unchanged from 003.
- [ ] Median per-chunk load time is within 1.5× of median per-chunk save time. If not, the Handoff states the measured figures and says the diagnosis was incomplete.
- [ ] Load wall clock for the 5 MB gate 3 build is under 120 s, down from 518.9 s.
- [ ] `?dev=gate3&evict=17` still PASSes with matching digests, and the evicted chunk's load time is reported.
- [ ] A load run with `cacheKeyBase` forced to `null` still produces byte-identical output, proving the cold path.
- [ ] Saving a build twice and loading it returns the second revision, not a cached copy of the first.
- [ ] `docs/PHASE0_RESULTS.md` shows before and after; `docs/DEFERRED.md` records the OAuth-token reasoning; `CHANGELOG.md` has the `005` entry.
- [ ] No `TODO` in `src/`, no `localStorage`, no secrets.

## Handoff (Builder fills in)

### What changed

`api_loadBuildInfo` now keeps the base64 it was already computing and primes a
per-chunk cache with it; `api_loadChunk` reads that cache and falls back to the
old path on any miss. The client threads `cacheKeyBase` through and times every
chunk in both directions. Nothing about the save path changed.

Files: `src/server/Api.gs`, `src/server/Code.gs` (passes `evict`/`cold` into the
boot payload), `src/server/Index.html` (harness), `src/client/persistence/load.js`,
`save.js`, new `stats.js`, `src/client/main.js`, `tests/server-logic.test.js`,
`docs/PHASE0_RESULTS.md`, `docs/DEFERRED.md`, `CHANGELOG.md`.

130 tests across 7 files, `npm run build` passes, `dist/client/` still exactly
the seven locked files.

### Verified in-session

The real `Api.gs`, `Storage.gs` and `Code.gs` run in a Node sandbox with
in-memory Apps Script stand-ins, driven by the real client transport and the
real `Index.html` in headless Chromium. All three modes round-trip 5,242,880
bytes with digest `065ce635…84d374d7` matching on both sides:

| Run | Cache hits / misses | Gate 3 | Median load / median save |
|---|---|---|---|
| `?dev=gate3` | 70 / 0 | PASS | 0.67x |
| `?dev=gate3&evict=17` | 69 / 1 | PASS | 0.71x |
| `?dev=gate3&cold=1` | 0 / 70 | PASS | 5.67x |

Screenshot of the evict run: `screenshots/005-gate3-evict-harness.png`.

**Read those ratios as an A/B, not as a prediction.** In the sandbox a "Drive
read" is a Buffer copy, so every absolute number is meaningless for the
deployment. What is meaningful is that the same harness, same machine, same
build, reports 0.67x warm and 5.67x cold. That gap is the defect appearing and
disappearing on demand, which is the evidence that 005 targets the right
mechanism. It is not evidence about what the deployment will do.

The `cold=1` run also satisfies the acceptance item about forcing
`cacheKeyBase` to null: 70 misses, byte-identical output.

### What you have to run

1. **`?dev=gate3` on the stable URL.** The number that decides this ticket is
   **median per-chunk load against median per-chunk save**, and only a real
   deployment produces it. Transcribe the whole panel into
   `docs/PHASE0_RESULTS.md`, which already holds the before column.
2. **`?dev=gate3&evict=17`.** Must still PASS, and the evicted chunk's own load
   time is reported separately so the fallback's real cost is visible.
3. Optionally `?dev=gate3&cold=1` to see the pre-005 behavior on the deployment.

If the median ratio comes back above 1.5x, the diagnosis in this ticket was
incomplete and the Handoff has to say so with the figures rather than pointing at
a smaller total. I have not pre-written that sentence, because writing it before
the measurement exists is how a number gets talked into looking good.

### Measured on the deployment — both thresholds met

Owner's runs on the stable URL, tag `build-9`, 2026-09-19. Full transcription in
`docs/PHASE0_RESULTS.md`.

| Run | Hits / misses | Median save | Median load | Ratio | Load wall clock | Gate 3 |
|---|---|---|---|---|---|---|
| `?dev=gate3` 22:39:00Z | 70 / 0 | 672 ms | 542 ms | **0.81x** | **48.3 s** | PASS |
| `?dev=gate3&evict=17` 22:43:08Z | 69 / 1 | 682 ms | 594 ms | 0.87x | 57.3 s | PASS |

Budget was 1.5x and 120 s. Both runs clear both, with the ratio under 1.0 — per
chunk the load is now marginally faster than the save. Digests matched on both
runs. **The diagnosis in this ticket was complete**: the sentence I refused to
pre-write is not needed.

The before/after comparison that is actually like-for-like is mean-to-mean,
because ticket 003's harness recorded no per-chunk distribution: **7,412.9 ms →
690.0 ms per chunk on load, 10.7x.** The 0.81x is a within-run ratio against the
acceptance budget, not a before/after figure.

The sandbox A/B called the direction right and the magnitude wrong, as flagged:
sandbox 0.67x warm / 5.67x cold against a deployed 0.81x warm. The evicted chunk
cost **4492 ms** on the deployment — the run's max, 7.6x its own median — so the
fallback is genuinely expensive per miss, and still cheaper than what every chunk
paid before 005. One miss costs one re-prime, not 70.

`?dev=gate3&cold=1` on the deployment was not run and is not needed; the
pre-005 behavior is already recorded as the 518.9 s `build-6` run.

### Deviations and judgement calls

- **`api_loadChunk` now returns `{ chunk, cached }` rather than a bare string.**
  §5 requires the panel to report cache hits and misses, and the client cannot
  measure that without being told; inferring it from timing is exactly the kind
  of heuristic this ticket exists to replace. `load.js` accepts both shapes, so a
  deployment running an older `Api.gs` than the bundle still loads, it just
  cannot report hits. This is the one API-surface change and it is not in §14.2's
  wording, which says "base64 chunk".
- **`api_devEvictChunk` ships without the trailing underscore** the ticket
  specifies. `api_devEvictChunk_` cannot be called by `google.script.run`, and
  the harness calls it from the page, so as written the live exercise in §4 could
  not run. Same defect class as `api_getBundle_` in 003. It is owner-only and
  validates its key base.
- **`cacheKeyBase` is validated against the `buildId`, not trusted.** It is
  caller-controlled input that becomes a cache key. Without the check, a crafted
  base could read `ks_upload_*` or `ks_settings` out of the shared script cache.
  `isDownloadKeyBase_` requires the exact `ks_dl_<buildId>_<alnum>` shape. Do not
  remove it: the whole point of passing the base is to avoid a Sheet read, so
  recomputing it server-side to compare would give back the saving.
- **Batch size 10, not larger.** 10 keys is about 1 MB per `putAll`. The
  documented cap is per key, not per call, so this is a margin chosen without a
  measured limit behind it. 70 writes become 7.
- **The miss path re-populates only the key that missed**, not the whole build.
  Re-priming everything on a miss would turn one slow read into one slow read
  plus a full cache rewrite.

### A separate defect found while doing this, not fixed here

**A throwing `CacheService` locks every user out of the app.** `getUserRole_`
(ticket 002) reads the users cache without guarding the call, `requireAccess_`
catches whatever escapes and sets `role = null`, and `decideAccess_` turns that
into `ACCESS_DENIED`. Verified directly: with a listed owner and a
`CacheService.get` that throws, `api_whoami` returns
`{ code: 'ACCESS_DENIED' }`.

A transient cache failure should degrade to a Sheet read, the same way this
ticket makes the download cache degrade to a Drive read. It is the identical
principle — correctness never depends on the cache — applied to the auth path,
which predates it.

Out of scope for 005, so it is recorded rather than fixed. It needs its own
ticket, and it is worth one: the failure mode is every family member locked out
at once, and it would look like an auth problem rather than a cache problem.

I found it because a first draft of the throwing-cache test stubbed `get` to
throw for all keys, and the call came back `ACCESS_DENIED` instead of the chunk.
The test now throws only for `ks_dl_` keys, so it tests the download path
rather than the auth path.
