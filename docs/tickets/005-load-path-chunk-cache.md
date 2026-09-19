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
