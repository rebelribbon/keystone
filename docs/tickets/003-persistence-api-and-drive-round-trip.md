# 003 — Persistence API and Drive round-trip
Phase: 0 · Tag: hard · Spec sections: §2.1 (gate 3), §3, §6.4, §14.1, §14.2, §14.3, §16, §18 · Decisions: ADR 0001

## Goal

Close Phase 0 gate 3: a 5 MB build saves to Drive, gzipped and chunked, and loads back byte-identical. This ticket builds the server persistence API (`Api.gs`, the Drive and `Builds`-tab half of `Storage.gs`) and the client transport that feeds it (gzip, base64, chunking, promise-wrapped `google.script.run`). It also applies ADR 0001, replacing the `/dev`-based channel detection that Phase 0 verification found unusable.

There is no Store and no real Build document yet, so gate 3 runs against a deterministic 5 MB dummy buffer. Autosave, recovery copies, the builds screen, export/import, and screenshots are Phase 1.

## Requirements

### 1. Channel model correction (ADR 0001)

Land ADR 0001 in the repo as `docs/decisions/0001-test-channel-uses-a-versioned-deployment.md`, verbatim as provided, and make the code match it:

- Replace `resolveChannel_(serviceUrl, paramChannel, role)` with `resolveChannel_(params)`: returns `"test"` when `params.c === "test"`, `"stable"` otherwise. No service-URL inspection, no role check.
- `?tag=` and `?dev=` stay owner-only, unchanged.
- Update `docs/SETUP.md`: two versioned `/exec` deployments, both recorded, with `?c=test` appended to the test bookmark. Remove every reference to the `/dev` URL as a supported entry point. Keep the existing practice of pointing `stable_tag` at the newest verified tag rather than a hardcoded `build-1`.
- Update the `Keystone` menu's two items to show the two deployment URLs, test with `?c=test`.

This is a named requirement, not a drive-by: the test channel is unverified until it lands, and every acceptance check below that mentions a channel depends on it.

### 2. `Storage.gs` — Drive and the `Builds` tab

Extend the file created in ticket 002. Existing settings and users helpers stay as they are.

- `getBuildsFolder_()` — resolves `builds_folder_id` from `Settings` and returns the `Folder`. Throws a structured error naming the missing or invalid setting.
- `getTrashFolder_()` — returns the `Trash` subfolder of the builds folder, creating it on first use.
- `readBuildRow_(buildId)` / `writeBuildRow_(row)` / `appendBuildRow_(row)` — the `Builds` tab, whose header order is locked by §14.1: `buildId | name | owner | primaryStyle | levels | estCostLow | estCostHigh | created | updated | driveFileId | thumbFileId | schema | deleted`. Read the header row and map by name; never index by hardcoded column number.
- `writeBuildFile_(buildId, bytes)` / `readBuildFile_(driveFileId)` — one `<buildId>.ksb` per build holding raw gzip bytes (§6.4). Overwrite in place when the file already exists; do not accumulate Drive revisions beyond what Drive does on its own.
- Pure helpers exported for tests: `rowToBuild_(header, row)`, `buildToRow_(header, obj)`, `isConflict_(baseUpdated, serverUpdated)`.

### 3. `Api.gs` — §14.2 functions

Create the file. Move `api_whoami` here from `Code.gs` (§3 puts the §14 functions in `Api.gs`; leaving it behind would split the API across two files on day one).

Implement:

| Function | Notes |
|---|---|
| `api_whoami()` | moved from `Code.gs`, behavior unchanged |
| `api_listBuilds()` | non-deleted rows, newest `updated` first |
| `api_beginSave(buildId, meta)` | returns `{ uploadId }`; `buildId` null means a new build and the server mints the id |
| `api_saveChunk(uploadId, index, base64)` | stores one chunk in `CacheService`, 6 h TTL |
| `api_commitSave(uploadId, totalChunks, thumbBase64)` | assembles, writes the Drive file, updates or appends the index row, under `LockService` |
| `api_loadBuildInfo(buildId)` | `{ meta, totalChunks }` |
| `api_loadChunk(buildId, index)` | one base64 chunk |
| `api_deleteBuild(buildId)` | soft delete: set `deleted`, move the Drive file to `Trash` |
| `api_getSettings()` / `api_setSetting(k, v)` | `api_setSetting` is owner-only and invalidates the settings cache |

Every function: auth check first, `try`/`catch`, structured `{ code, message }` errors, and a `Log` row on every write (`save`, `delete`, `setting`). Reads are not logged.

**Chunk cap.** `CacheService` enforces a per-key size cap well below the 1.5 MB §6.4 names. The client halves its chunk size and retries on rejection, down to a 100 KB floor (§14.2). The server's job is to reject an oversized chunk with code `CHUNK_TOO_LARGE` rather than failing opaquely, so the client can act on it. See the risk note in §7.

**Conflict rule.** `api_commitSave` compares the client's `baseUpdated` against the index row's `updated`. If the server's is newer, it writes a new build named `<name> (conflict copy)` and returns `{ conflict: true, buildId: <new id> }`. The original is untouched.

**`thumbBase64` may be null.** There is no thumbnail pipeline until Phase 4; a null skips the thumb write and leaves `thumbFileId` empty. `api_getThumb` and `api_duplicateBuild` are deferred — see §6.

### 4. Client transport

New files under `src/client/persistence/`:

- `codec.js` — `gzip(uint8) → Promise<Uint8Array>` and `gunzip(uint8) → Promise<Uint8Array>` via `CompressionStream`/`DecompressionStream`; `toBase64(uint8)` and `fromBase64(str)` that process in fixed-size windows rather than one `String.fromCharCode.apply` over the whole buffer, which blows the call stack at these sizes.
- `chunker.js` — `chunk(str, size) → string[]` and `nextChunkSize(current)` implementing the halving ladder 1.5 MB → 750 KB → 375 KB → 187 KB → 100 KB floor. Below the floor, fail with a clear error rather than looping.
- `transport.js` — promise wrapper around `google.script.run` with `withSuccessHandler`/`withFailureHandler`, a per-call timeout, and one retry on transient failure. Structured server errors reject with the `{ code, message }` intact.
- `save.js` / `load.js` — the chunk loops. `save` gzips, base64s, chunks, calls `beginSave`, uploads every chunk in order, then `commitSave`, halving and restarting the upload on `CHUNK_TOO_LARGE`. `load` calls `loadBuildInfo`, pulls every chunk, reassembles, base64-decodes, gunzips.

`codec.js` and `chunker.js` must be pure and importable by vitest under Node 20. No `google.script.run` reference outside `transport.js`. No `localStorage`, no IndexedDB in this ticket.

### 5. Gate 3 harness — `?dev=gate3`

Owner-only, alongside the `?dev=gates` panel from 002. It:

1. Generates a deterministic 5 MB buffer from a fixed seed (a small xorshift PRNG, so the same bytes every run and no dependence on `Math.random`).
2. Records its SHA-256 via `crypto.subtle`.
3. Saves it as a build named `gate3-roundtrip`, timing the save.
4. Loads it back by `buildId`, timing the load.
5. Compares SHA-256 of the loaded bytes to the original.
6. Soft-deletes the test build.
7. Prints: PASS/FAIL, both digests, save and load wall-clock seconds, the final chunk size the client settled on, and the chunk count.

Add the gate 3 row to `docs/PHASE0_RESULTS.md` from the owner's run. Update gates 1, 2, 4, 5 in that file to record that they were verified on the **stable** channel, and add a line noting `/dev` is out of the model per ADR 0001.

### 6. Deferred, with reasons in `docs/DEFERRED.md`

- `api_getThumb` — no thumbnail pipeline exists until Phase 4 (§13.3). Writing a getter for data nothing produces would ship untested code.
- `api_duplicateBuild` — only reachable from the builds gallery (Phase 1). It will be written against that screen.
- `api_exportCost` (§15) — the cost engine is Phase 4.
- Autosave, IndexedDB recovery copies, export/import, screenshots (§14.3) — Phase 1, and they need a real Store to serialize.

## 7. Risk to measure, not to solve here

The spec's 1.5 MB chunk size cannot survive `CacheService`'s per-key cap, so the client will settle near the 100 KB floor. Base64 inflates payloads by a third, so a 5 MB gzip build becomes roughly 65–70 chunks, each a separate `google.script.run` round trip. That may put gate 3's save well over a minute.

Do not redesign this in this ticket. Implement the ladder as specified, and **report the measured save and load times and chunk count in the Handoff**. If the 5 MB save exceeds 90 seconds, say so plainly and stop there; the Architect will issue an ADR moving chunk staging from `CacheService` to an append-in-place temp Drive file, and that becomes its own ticket.

## Out of scope

- The Store, commands, events, and any real Build document. Gate 3 uses a dummy buffer.
- The builds gallery, new-build wizard, and every UI panel in §13.2.
- Autosave, recovery, export/import, screenshots.
- `Updater.gs`, the *Update server code* menu item, and gate 6 — ticket 004.
- Thumbnails, cost, catalog content.
- Any change to the release workflow or tag scheme.

## Acceptance

- [ ] `npm test` and `npm run build` pass; `dist/server/` now contains `Api.gs` alongside `appsscript.json`, `Code.gs`, `Storage.gs`, `Index.html`.
- [ ] `tests/codec.test.js`: a 5 MB pseudo-random buffer survives gzip → base64 → chunk → reassemble → base64-decode → gunzip byte-identical; `toBase64`/`fromBase64` round-trip at 5 MB without a stack overflow.
- [ ] `tests/chunker.test.js`: the halving ladder produces exactly 1.5 MB → 750 KB → 375 KB → 187 KB → 100 KB and then throws; `chunk()` reassembles losslessly including a non-multiple final chunk.
- [ ] `tests/server-logic.test.js` extended with `rowToBuild_`/`buildToRow_` (header-order independence, missing column handling) and `isConflict_` (server newer, client newer, equal timestamps, missing `baseUpdated`).
- [ ] `resolveChannel_` tests updated for ADR 0001: `?c=test` → test, `?c=stable` → stable, absent → stable, garbage → stable, and the value is honored regardless of role.
- [ ] `docs/decisions/0001-test-channel-uses-a-versioned-deployment.md` exists.
- [ ] On the deployed stable URL, `?dev=gate3` reports PASS with matching SHA-256 digests. Digests, timings, chunk size, and chunk count are in the Handoff.
- [ ] After the gate 3 run, the `Builds` tab has one row with `deleted` set, the `.ksb` file sits in the `Trash` subfolder, and the `Log` tab has the matching `save` and `delete` rows.
- [ ] A second browser signed into a non-`Users` account still gets the access screen on every `api_*` call, not just on `doGet`.
- [ ] The test deployment, opened with `?c=test`, loads the newest `build-*` tag while the stable deployment loads `stable_tag`, with the owner signed into multiple Google accounts.
- [ ] Forcing a conflict — save, edit the `Builds` row's `updated` to a later time by hand, save again with the stale `baseUpdated` — produces a `(conflict copy)` build and leaves the original untouched.
- [ ] `docs/PHASE0_RESULTS.md` records gate 3, notes the stable-channel caveat on gates 1, 2, 4, 5, and notes `/dev` is out of the model.
- [ ] `docs/DEFERRED.md` lists the four deferrals in §6 with reasons.
- [ ] No secrets, Sheet IDs, or Drive folder IDs in the repo. No `TODO` in `src/`. No `localStorage`.

## Handoff (Builder fills in)

### What changed

The server persistence API, the client transport that feeds it, the `?dev=gate3`
harness, and ADR 0001's channel correction. Gate 3 itself still needs your run on
a deployment — see **What you have to verify** below.

### Files

Added: `docs/decisions/0001-...md` (verbatim), `src/server/Api.gs`,
`src/client/persistence/{codec,chunker,transport,save,load}.js`,
`tests/codec.test.js`, `tests/chunker.test.js`,
`screenshots/003-gate3-harness.png`.

Changed: `src/server/Storage.gs` (Drive + `Builds`), `src/server/Code.gs`
(ADR 0001, `api_whoami` moved out, `api_getBundle` renamed and hardened),
`src/server/Index.html` (gate 3 harness), `src/client/main.js`
(`KS.persistence`), `tests/server-logic.test.js`, `docs/SETUP.md`,
`docs/PHASE0_RESULTS.md`, `docs/DEFERRED.md`, `CHANGELOG.md`.

`npm test` is 122 tests across 7 files, `npm run build` passes, `dist/server/`
now carries `Api.gs`, and `dist/client/` is still exactly the seven locked files.

### Verified in-session, and how

I cannot deploy Apps Script, so I ran the **real** `Storage.gs`, `Code.gs`, and
`Api.gs` in a Node sandbox with in-memory stand-ins for `SpreadsheetApp`,
`CacheService`, `DriveApp`, `LockService`, `Utilities`, and `Session`, exposed
them over HTTP, shimmed `google.script.run` to reach them, and drove the real
`Index.html` and the real client transport in headless Chromium. This exercises
the shipped server logic, not a reimplementation of it.

**Gate 3 flow passed** (`screenshots/003-gate3-harness.png`):

| Measure | Value |
|---|---|
| Buffer | 5,242,880 bytes |
| SHA-256 before gzip | `065ce6350937b564c88562c4fb60be579942f8732cb5a2d2e0e30a3184d374d7` |
| SHA-256 after gunzip | `065ce6350937b564c88562c4fb60be579942f8732cb5a2d2e0e30a3184d374d7` |
| gzip / base64 | 5,244,503 bytes / 6,992,672 chars |
| Final chunk size | 100,000 chars |
| Chunk count | 70 |
| Upload attempts | 5 |

The ladder behaved exactly as §7 predicted: four rejections (1.5 MB, 750 KB,
375 KB, 187.5 KB) then success at the 100 KB floor, 70 chunks.

Side effects checked against the acceptance list: the `Builds` row ends with
`deleted` = `true`, the `.ksb` sits in the `Trash` subfolder with the Builds
folder empty, and `Log` has exactly the `save` and `delete` rows — no read
logging.

**Conflict rule checked** against the same live API: a save carrying a stale
`baseUpdated` produced `<name> (conflict copy)` under a new id, left the
original's `updated` and `driveFileId` untouched, and a save carrying the
current `baseUpdated` committed cleanly with no conflict.

### What you have to verify

Everything above is local and in-process. It proves the logic, not the platform.
These still need a deployment:

1. **`?dev=gate3` on a real URL.** The numbers that matter are the timings, and
   my 0.8 s save measures local function calls, not `google.script.run` round
   trips. 70 sequential round trips is the §7 risk. Transcribe the panel into
   `docs/PHASE0_RESULTS.md`, and if the save exceeds 90 seconds say so — per §7
   that is the Architect's signal to move chunk staging off `CacheService`.
2. **Two versioned deployments.** `docs/SETUP.md` steps 7–8 are rewritten for
   ADR 0001. You need a second `/exec` deployment, both URLs in Settings as
   `test_url` and `stable_url`, and `?c=test` on the test bookmark. The check
   that the model works: the two URLs report different tags in the console while
   you are signed into several Google accounts.
3. **A second, unlisted Google account** hitting the page and an `api_*` call.
4. **The conflict path by hand**, editing `updated` in the Sheet, if you want it
   confirmed against real Sheets timestamps rather than ISO strings.

### `api_getBundle_` — the rename, and the gate that has to travel with it

You were right that the name blocks `google.script.run`, and it is renamed to
`api_getBundle`.

One correction to the diagnosis, because it changes what was at risk: as shipped
in 002, `loader_mode: inline` was **not** dead. `Index.html` never called it from
the client — `doGet` called `getBundleSource_` server-side during template
evaluation, where a trailing underscore is irrelevant. So inline mode would have
worked; what the name blocked was the client-callable path §14.2 describes, and
any future caller reaching for it from the page.

#### Why the rename is not safe on its own

**Do not remove the following without replacing it.** Dropping the trailing
underscore changed this function's blast radius, and the two guards below exist
only because of that change. They look like defensive boilerplate. They are not.

The web app runs `executeAs: USER_ACCESSING` with `access: ANYONE`, so **anyone
with a Google account can reach a `google.script.run` endpoint** — the `Users`
tab is the only thing standing between a stranger and the API. Every other
`api_*` function goes through `apiCall_`, which checks that first. `api_getBundle`
lives in `Code.gs` and predates `Api.gs`, so it never had that check: as a
private function it did not need one, because the only caller was `doGet`, which
had already authorized the request.

As renamed, and with no guards, it would have been an **unauthenticated endpoint
that takes a URL fragment from the caller**: `tag` and `file` are concatenated
into `{base}/dist/client/<file>` and fetched with `UrlFetchApp` from the script's
own authority. That is a fetch proxy and a path-traversal surface, reachable by
any Google account, on a public repo's deployment.

So `api_getBundle` now carries two guards:

1. **The `Users` gate**, matching every other `api_*` function: it resolves the
   caller with `activeEmail_` / `getUserRole_` and returns
   `{ code: 'ACCESS_DENIED' }` for anyone without a row. It is written inline
   rather than through `apiCall_` only because `apiCall_` lives in `Api.gs` and
   this function is in `Code.gs`; if the two ever merge, route it through
   `apiCall_` rather than deleting the check.
2. **Argument allowlists, not sanitizing.** `tag` must match `^build-\d+$`.
   `file` must be one of the six entries in `KS_CLIENT_BUNDLES` — an exact
   membership test, not an extension check or a `..` filter. Both return
   `{ code: 'BAD_REQUEST' }`. Allowlisting is the point: a denylist of bad paths
   is a guessing game, a list of the six files we actually publish is not.

Both are pinned by tests in `tests/server-logic.test.js`: `api_getBundle` is in
the table asserting every `api_*` function denies an unlisted account and an
unresolvable one, and a separate case asserts `../../etc` as a tag, a traversal
path as a file, and `styles.css` (real file, not a client bundle) are all
rejected. A "simplification" that drops either guard turns those tests red, which
is the intended tripwire.

### Deviations worth your eye

- **`writeBuildFile_` replaces rather than overwrites in place — owner approved.**
  §2 asks for overwrite-in-place. DriveApp cannot replace a file's *binary*
  content (`setContent` is text-only), so a re-save trashes the previous `.ksb`
  and creates a fresh one under the same name, updating `driveFileId` on the row.
  The owner reviewed this and **ruled that trash-and-recreate is the contract —
  one live `.ksb` per build — and that the Drive advanced service is not to be
  pulled in for it.** Treat that as settled: do not add
  `advancedServices` to `appsscript.json` for this, and do not "fix" the
  trash-and-recreate into something that needs it.
- **`isConflict_` treats a missing `baseUpdated` as a conflict** when a server
  row exists. §3 does not say which way to fall; refusing to clobber is the only
  choice whose failure mode is a spare copy rather than lost work. New builds are
  unaffected — there is no row to conflict with.
- **The menu reads `test_url` / `stable_url` from Settings.** Two versioned
  deployments of one project cannot discover each other's URLs from inside the
  script — that is the same limitation ADR 0001 cites for detection — so the
  URLs have to be recorded. The serving deployment's own URL is the fallback
  while they are blank.
- **`api_loadBuildInfo` and `api_loadChunk` re-read and re-encode the Drive file
  on every call.** For a 5 MB build that is 70 reads of the same file during one
  load. It is correct and it is simple, and caching it would need its own
  invalidation story; if load timings come back bad on the real deployment, this
  is the first thing to change.

### Known gaps

- `src/server/` is still only compile-checked and sandbox-tested. Nothing has
  executed against real `DriveApp`, `LockService`, or `CacheService`, and the
  100 KB cache cap I coded to is from Google's documented limit, not measured.
- `loader_mode: inline` remains unexecuted end to end, now for the second ticket
  running.
- Gate 6 and the updater are ticket 004.
