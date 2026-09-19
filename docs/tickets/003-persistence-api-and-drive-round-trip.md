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
