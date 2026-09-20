# Changelog

## 001 — Repo scaffold and release pipeline

Stood up the repository skeleton, the esbuild pipeline, the vitest harness, and
the two GitHub Actions workflows (spec §3, §3.1, §2.1 gate 5, §16).

Added:
- Repo layout, `.gitignore` (ignores `dist/`, `node_modules/`), `.nvmrc` (Node 20).
- `package.json` (`three@0.170.0`, `esbuild`, `vitest`) and `package-lock.json`.
- `build/build.mjs`: esbuild IIFE bundles (`vendor-three.js`, `engine.js`, and the
  four `catalog-*.js` packs), verbatim `styles.css` and `src/server/**` copy, and
  `dist/manifest.json` with tag/commit/build time and per-file size + SHA-256.
- Client scaffold: `window.KS` namespace (throws on double-load), catalog registry
  (store/duplicate/non-object rules only), the Phase 0 boot cube (§8.1), `KS.boot`,
  and the §13.1 identity tokens in `styles.css`.
- Four empty content packs: `core.materials`, `core.styles`, `core.exterior`,
  `core.interior`.
- Tests: `registry.test.js`, `manifest.test.js`, `build-output.test.js`.
- `.github/workflows/ci.yml` (PRs: `npm ci`/`test`/`build`) and
  `release.yml` (push to `main`: test, build, publish `dist/` to the `release`
  branch, tag `build-N`, GitHub Release with the manifest).
- `docs/DEFERRED.md`.

## 002 — Apps Script loader, auth, and Sheet menu

The Apps Script half of Phase 0 (spec §2.2, §3.1, §13.1, §14.1, §14.2, §2.1 gates 1, 2, 4).

Added:
- `src/server/appsscript.json`: V8, America/Chicago, Stackdriver logging, the five
  §2.2 OAuth scopes, web app `USER_ACCESSING` / `ANYONE`.
- `src/server/Storage.gs`: `Settings` and `Users` readers with a 300 s script-cache,
  `getSetting_`, `invalidateSettings_`, and `logRow_`. Pure `parseSettingsRows_` and
  `findRole_` are broken out for tests.
- `src/server/Code.gs`: `doGet` with the `Users` auth gate, channel resolution
  (`/dev` → test), tag resolution (newest `build-*` from the GitHub Releases API,
  cached 60 s, two tags kept) with a degraded fallback to `stable_tag`, base-URL
  construction, the access and configuration screens, `api_whoami`, the
  `api_getBundle_` inline fallback, and the `Keystone` Sheet menu. Pure helpers:
  `pickNewestBuildTags_`, `buildBaseUrl_`, `resolveChannel_`, `decideAccess_`,
  `applyTagOverride_`, `serviceUrlVariants_`, `splitChunks_`, `escapeHtml_`,
  `toSafeJson_`.
- `src/server/Index.html`: the §3.1 loader shell — seven `{base}/dist/client/...`
  references in order, all external scripts deferred, a per-file loading screen with a
  *Try the previous build* failure state, a degraded banner, and the owner-only
  `?dev=gates` panel running gates 1, 2, and 4. The boot payload is injected as one
  pre-escaped JSON blob; no value is concatenated into the page, and nothing is stored
  in the browser.
- `assets/test/checker.png`: a 64 px in-house checkerboard for gate 2.
- `tests/server-logic.test.js` (44 tests) evaluates the `.gs` files in a sandbox with
  stubbed Apps Script globals; `tests/loader-template.test.js` (11 tests) asserts the
  template's load order, defer, escaping, and absence of browser storage.
- `docs/SETUP.md` and `docs/PHASE0_RESULTS.md`.

Changed:
- `build/build.mjs`: manifest entries now sort by codepoint instead of `localeCompare`,
  so the file list is identical in a cloud session and on an Actions runner whatever
  their locale data. Mixed-case server filenames made the two orders diverge.
- `src/client/ui/styles.css`: added `.ks-loading[hidden] { display: none }`. The class's
  own `display: flex` out-specified the user-agent `[hidden]` rule, so the loading
  screen stayed on top of the cube after boot.

## 002 follow-up — Phase 0 gate results and setup fixes

Documentation only; no source or build changes.

- `docs/PHASE0_RESULTS.md`: transcribed the owner's `?dev=gates` run on the
  deployed web app (tag `build-4`, channel `stable`, loader `cdn`,
  2026-09-18T23:05:42.749Z). Gates 1, 2, 4, and 5 **PASS** — first frame at
  109 ms against a 6000 ms budget, canvas and jsDelivr PNG textures both clean,
  IndexedDB read-back byte-identical inside the deployed iframe. Gates 3 and 6
  remain pending on tickets 003 and 004. Phase 0 gates are now closed except
  those two.
- `docs/SETUP.md` step 4: stop naming `build-1` as the tag to copy server files
  from. `build-1`, `build-2`, and `build-3` have no `dist/server/` at all — the
  release workflow fires on every push to `main`, so tag numbers run ahead of
  ticket numbers. The step now sends the owner to the releases page for the
  newest tag, has them verify `dist/server/appsscript.json` resolves before
  copying, and offers the `raw.githubusercontent.com` form as a fallback.
- `docs/SETUP.md` troubleshooting: added the Google Drive "Sorry, unable to open
  the file at this time" case — signed into several Google accounts, Google
  rewrites the web app URL to `/macros/u/N/s/...` and Drive answers instead of
  the script. It mimics a broken deployment; the tell is that no `doGet`
  execution appears in the log, because the request never reaches the script.
- `docs/SETUP.md` Settings table: `stable_tag` now starts at the newest `build-*`
  tag — the one verified in step 4 — instead of `build-1`, with the same check
  that `dist/server/appsscript.json` resolves at it. Ticket 002 prescribed
  `build-1` on the assumption that merging 002 would produce `build-2`; the
  release workflow fires on every push to `main`, so that assumption does not
  hold. `build-1`, `build-2`, and `build-3` carry no `dist/server/`, and
  `build-1` also predates `assets/`, so gate 2 fails against the stable URL at
  that tag.

## 003 — Persistence API and Drive round-trip

Closes the code half of Phase 0 gate 3 (spec §2.1 gate 3, §3, §6.4, §14.1, §14.2,
§14.3; ADR 0001).

Added:
- `docs/decisions/0001-test-channel-uses-a-versioned-deployment.md`, verbatim.
- `src/server/Api.gs`: the §14.2 surface — `api_whoami` (moved from `Code.gs`),
  `api_listBuilds`, `api_beginSave`, `api_saveChunk`, `api_commitSave`,
  `api_loadBuildInfo`, `api_loadChunk`, `api_deleteBuild`, `api_getSettings`,
  `api_setSetting`. Every one is auth-first, wrapped in try/catch, returns a
  structured `{ code, message }`, and writes a `Log` row on writes only.
  `api_commitSave` runs under `LockService` and applies the conflict-copy rule.
- `src/server/Storage.gs`: Drive and `Builds`-tab helpers — `getBuildsFolder_`,
  `getTrashFolder_`, `readBuildRow_`, `writeBuildRow_`, `appendBuildRow_`,
  `listBuildRows_`, `writeBuildFile_`, `readBuildFile_`, `moveBuildFileToTrash_`,
  plus pure `rowToBuild_`, `buildToRow_`, `isConflict_`. Rows map by header name,
  never by column index.
- `src/client/persistence/`: `codec.js` (gzip/gunzip via CompressionStream,
  windowed base64 that does not overflow the stack at 5 MB), `chunker.js` (the
  1.5 MB → 750 KB → 375 KB → 187 KB → 100 KB ladder), `transport.js` (the only
  file naming `google.script.run`; timeout, one retry, structured errors
  preserved), `save.js`, `load.js`. Exposed as `KS.persistence`.
- `?dev=gate3`: owner-only harness that round-trips a deterministic 5 MB buffer
  and reports both digests, timings, final chunk size, and chunk count.
- `tests/codec.test.js` and `tests/chunker.test.js`; `tests/server-logic.test.js`
  grew to cover the Builds helpers, the conflict rule, the chunk cap, and the
  auth gate on every `api_*` function.
- `docs/SETUP.md`: two versioned `/exec` deployments, `?c=test` on the test
  bookmark, `test_url` and `stable_url` settings, and gate-run guidance.

Changed:
- **ADR 0001.** `resolveChannel_(serviceUrl, paramChannel, role)` becomes
  `resolveChannel_(params)`: the channel is `?c=test` or `?c=stable`, defaulting
  to stable, with no service-URL inspection and no role check. `serviceUrlVariants_`
  is gone and `withChannelParam_` replaces it. Every `/dev` reference is out of
  `docs/SETUP.md` as an entry point. `?tag=` and `?dev=` stay owner-only.
- **`api_getBundle_` renamed to `api_getBundle`.** Apps Script refuses to expose a
  name ending in an underscore to `google.script.run`, so the client-callable
  path the §2.1 gate 1 fallback is meant to offer was unreachable. Renaming it
  also makes it reachable by any signed-in Google account, so it now carries the
  same `Users` gate as the rest of the API and validates both arguments against
  allowlists rather than letting them steer the fetch URL.

## 003 follow-up — gate 3 results from the deployed run

Documentation only; no source or build changes.

- `docs/PHASE0_RESULTS.md`: transcribed the owner's `?dev=gate3` run on the
  deployed stable URL (tag `build-6`, 2026-09-19T16:54:39Z). **Gate 3 PASS** —
  5,242,880 bytes round-tripped byte-identical, SHA-256 `065ce635…84d374d7` on
  both sides, 70 chunks at the 100,000-character floor after 5 upload attempts.
  Phase 0 now has five gates passing; only gate 6 (the updater, ticket 004) is
  outstanding.
- Recorded the timing asymmetry: save 68.2 s, load 518.9 s. The save is under the
  90 s threshold ticket 003 §7 set, so its escalation is not triggered. The load
  is **7.61x the save over the same 70 chunks** (7.41 s vs 0.97 s per chunk),
  which §7 did not anticipate — it reasoned about the upload path only. The
  likely cause is `api_loadChunk` re-reading and re-encoding the whole Drive file
  per call. Measured and recorded, deliberately not fixed: the read-path design
  is the Architect's call.

## 005 — Load path chunk cache

Defect fix following 003 (spec §14.2, §18). No API renames, no spec change.

Changed:
- `src/server/Api.gs`: `api_loadBuildInfo` keeps the full Drive read and base64
  encode it was already paying for, and now primes a per-chunk cache with the
  result instead of discarding it. Keys are `ks_dl_<buildId>_<revision>_<index>`,
  6 h TTL, written with `putAll` in batches of 10. A failed batch is logged and
  ignored: a cache write that does not land degrades to slow reads, never to an
  error.
- `api_loadChunk(buildId, index, cacheKeyBase)` reads the cache first and falls
  back to the original read-encode-slice path on any miss — eviction, expiry, a
  missing `cacheKeyBase`, or a cache `get` that throws — re-populating just the
  key that missed. The two paths return identical bytes; the tests assert the
  hit and the miss byte-for-byte against each other.
- The revision stamp in the key comes from the row's `updated`, so a re-saved
  build gets a fresh key space and can never serve chunks from its previous
  revision.
- `cacheKeyBase` is caller-controlled input used to build a cache key, so
  `isDownloadKeyBase_` binds it to the `buildId` argument. A crafted value
  cannot reach `ks_upload_*` or `ks_settings` in the shared script cache, and
  validating the shape costs nothing where recomputing it would cost exactly
  what this ticket removes.
- `src/client/persistence/load.js` threads `cacheKeyBase` through, times every
  chunk, and counts hits and misses. `save.js` times its chunks too so the two
  directions can be compared.
- `src/client/persistence/stats.js` (new): min / median / max. Median, not mean —
  one outlier should not move the number being compared.
- `?dev=gate3` reports per-chunk min/median/max for both directions, wall clocks,
  cache hits and misses, and the median load/save ratio against a 1.5x budget.
  `&evict=N` drops one primed chunk through the new owner-only
  `api_devEvictChunk` to exercise the fallback live; `&cold=1` sends no
  `cacheKeyBase` at all, forcing every chunk down the slow path.

Added:
- Eight tests in `tests/server-logic.test.js` covering the cache hit, the miss,
  hit-equals-miss equality, re-population, the null `cacheKeyBase` cold path, a
  throwing cache `get`, revision invalidation, and the key-base guard.
- `docs/DEFERRED.md`: the rejected direct-Drive-fetch optimization and why the
  `drive.file` scope narrowing is its prerequisite.

Note: ticket 005 spells the eviction helper `api_devEvictChunk_`. It ships
without the trailing underscore, because Apps Script will not expose such a name
to `google.script.run` and the harness calls it from the page — the same defect
ticket 003 fixed in `api_getBundle`.


## 005 follow-up — gate 3 re-run results from the deployment

Documentation only; no source or build changes.

- `docs/PHASE0_RESULTS.md`: transcribed the owner's two `?dev=gate3` re-runs on
  the deployed stable URL (tag `build-9`, 2026-09-19T22:39:00Z and 22:43:08Z).
  **Both PASS**, both digest-matching. Load wall clock **518.9 s → 48.3 s**.
  518.9 s is kept as the before value.
- Both of ticket 005's acceptance thresholds are met: median per-chunk load ÷
  median per-chunk save is **0.81x** against a 1.5x budget (542 ms load, 672 ms
  save), and load wall clock is 48.3 s against a 120 s budget. Per chunk the
  load is now marginally faster than the save, so the diagnosis in 005 was
  complete.
- The like-for-like before/after figure is mean-to-mean — **7,412.9 ms →
  690.0 ms per chunk on load, 10.7x** — because ticket 003's harness recorded no
  per-chunk distribution, only wall clock. The doc now labels the `build-6`
  per-chunk column as wall clock ÷ 70 so the 0.81x is never read as a
  before/after ratio.
- The `&evict=17` run is recorded with it: 69 hits / 1 miss, the evicted chunk
  costing **4492 ms** (the run's max, 7.6x its own median) and the load finishing
  in 57.3 s. The fallback's per-miss cost is real, bounded to one re-prime, and
  still below the 7,412.9 ms every chunk paid before 005.
- Save is unchanged as expected: 68.2 → 70.8 → 68.2 s across the three runs.

## 004 — Server updater and gate 6

The last piece of Phase 0 machinery (spec §2.1 gate 6, §2.2, §3.2, §16, §18;
ADR 0002). Ends the copy-paste-and-deploy ritual for the test channel.

Added:
- `src/server/Updater.gs`: the whole gate-6 sequence. A tag picker listing the
  newest ten `build-*` releases with their dates and a badge on the one the
  project is running; fetch of `dist/server/*` at the chosen tag; SHA-256 of
  every fetched file checked against the release manifest; a merge-not-replace
  write through the Apps Script API; a new version; and a repoint of the
  **test** deployment. Promotion to **stable** is a separate menu item that
  creates nothing and only moves a version that is already on test.
- Pure helpers, all unit-tested: `updaterEntryForPath_` (extension → Apps Script
  file type, unknown extensions abort), `mapServerEntries_`, `manifestDigests_`,
  `bytesToHex_`, `mergeProjectFiles_`, `fingerprintDigests_`, `backupFileName_`,
  `staleBackupNames_`, `releaseDatesByTag_`, `updaterApiHint_`.
- `docs/decisions/0002-updater-manages-versions-and-deployments.md`, verbatim.
- 33 tests in `tests/server-logic.test.js` and 2 in `tests/manifest.test.js`.

Changed:
- `src/server/appsscript.json`: added the `script.deployments` scope. **This
  forces re-authorization** — the first run after this merges prompts the owner
  again, and every other user the next time they open the web app (ADR 0002).
- `src/server/Code.gs`: the menu gains *Update server code…* and *Promote server
  code to stable…*, both owner-only. `pickNewestBuildTags_` takes an optional
  limit (default 2, unchanged for the loader) so the picker asks the same
  function for ten instead of carrying a second copy of the selection logic.
  `?dev=gates` now carries `server_tag` and `server_fingerprint`.
- `src/server/Storage.gs`: `writeSetting_` extracted from `api_setSetting`, which
  now delegates to it, so the updater's `server_tag` and `server_fingerprint`
  writes use the same upsert.
- `src/server/Index.html`: the `?dev=gates` panel prints which server code is
  running, or says plainly that no update has been run yet.
- `docs/SETUP.md`: step 4 is now a one-time bootstrap of **five** files
  (`Api.gs` and `Updater.gs` were missing from the list); a new step turns on the
  Apps Script API, which is off by default per account and otherwise fails the
  first run with a 403; both deployment IDs go into `Settings`; a new step 13
  covers updating and promoting from the menu; and the manual
  restore-from-backup procedure and five new troubleshooting entries are added.
- `docs/PHASE0_RESULTS.md`: a gate 6 section with the table the owner's live run
  fills in, including the row that *is* the gate — the project's files change
  with nobody opening the Apps Script editor.

Safety properties worth keeping:
- **Any digest mismatch aborts before a single write.** A partial or tampered
  server push is worse than a stale one.
- **The PUT merges.** `PUT .../content` replaces the entire project, so a file
  the release does not name is carried through untouched, and a payload that
  would omit `appsscript` is refused outright — losing the manifest takes the
  scopes and the web app configuration with it.
- **Every run backs the project up first**, to `server-backup-<timestamp>.json`
  in the Builds folder, ten kept.
- **The OAuth token never leaves the server.** It goes into the `Authorization`
  header and nowhere else; a test asserts it appears in no result, log row, or
  backup. This is the opposite case to the client-side Drive token ticket 005
  rejected, and the distinction is exactly where the token lives.

## 004 follow-up — the `script.container.ui` scope

Owner hit *"Specified permissions are not sufficient to call
Ui.showModalDialog"* on the first live run of the updater.

- `src/server/appsscript.json`: added
  `https://www.googleapis.com/auth/script.container.ui`. Nothing else changed —
  the menu and dialog code were already correct.
- **A spec gap, not a 004 defect.** SPEC §2.2's scope list omits it. Ticket 002
  built the `Keystone` menu against that list and ticket 004 was told to add
  `script.deployments` and nothing else. Neither could have found it from the
  repo: Apps Script checks the scope at call time, on a deployment.
- **Ticket 002's *Open test URL* and *Open stable URL* have the same dependency**
  and have been broken since 002. They were never exercised — the owner reached
  both URLs from bookmarks. The updater is simply the first menu item with no way
  around it. Flagged for the Architect as an ADR or a §2.2 correction.
- `tests/server-logic.test.js`: a new block asserts the manifest declares a scope
  for every Apps Script service the server actually calls, matched by source
  pattern (`getUi` → `script.container.ui`, `UrlFetchApp` →
  `script.external_request`, `DriveApp` → `drive`, `/deployments/` →
  `script.deployments`, …), and that no scope is declared which nothing uses.
  Removing the scope fails the test; that was verified, not assumed.
  The sandbox stubs `getUi`, so this class of defect was unreachable from vitest
  until the manifest itself became the thing under test.
- `docs/SETUP.md`: seven scopes, a troubleshooting entry naming the exact error
  and the fix, and the re-authorization note now covers both new scopes.

Costs the owner one more re-authorization prompt, for the same reason as ADR
0002's: the scope list changed.

## 004 follow-up — error messages report instead of diagnosing

The updater failed at the backup step with *"The Settings key builds_folder_id
does not name a Drive folder this account can open."* The folder id was correct
and the folder opened fine in a browser. That message was a guess written into a
`catch`, and it was the third such message in one day to name a plausible but
wrong cause.

Changed:
- `src/server/Storage.gs`: `getBuildsFolder_` and `readBuildFile_` no longer
  replace the exception with a theory. They report the call that was made, the
  id it was given, the verbatim Apps Script exception, and which account the code
  ran as — and say explicitly that this does not establish the id is wrong. New
  codes `DRIVE_FOLDER_FAILED` and `BUILD_FILE_FAILED` replace `SETTING_INVALID`
  and `BUILD_FILE_MISSING` on those paths.
- `describeError_` and `identityNote_` (new, pure): render an exception without
  inventing text, and report active vs. effective user. Both degrade to a note
  rather than throwing.
- `src/server/Updater.gs`: the Apps Script API error now leads with the verbatim
  response and puts its hypothesis last, prefixed *"Possible cause:"*. That is
  the one place in the server allowed to speculate, and now it is labelled.

Added:
- **Keystone → Diagnose access…** (owner-only). Reports the identity, the OAuth
  scopes Google *actually granted* — read from Google's tokeninfo endpoint, not
  from the manifest, because a consent screen can grant a subset of what was
  requested — and one line per Apps Script service the server depends on: the
  Settings read, Drive in general, the Builds folder specifically, the Apps
  Script API, and an external fetch. Each is OK or the verbatim exception.
  Nothing in it draws a conclusion.
  `Drive at all` failing alongside `Builds folder` is the discriminator the
  original message destroyed: it separates "no Drive access" from "wrong id".
- Nine tests pinning the contract, including that the old guessed wording is
  gone, that `Possible cause:` follows the verbatim response, and that the
  diagnostic never returns the OAuth token.
- `docs/SETUP.md`: a *Diagnose access* section with a table of what each
  combination of probe results narrows to, and the old error message's
  troubleshooting entry rewritten to say it was wrong.

Screenshot: `screenshots/004-diagnose-access.png`, driven in headless Chromium
against the real `.gs` files with Drive stubbed to fail the way it did live.

## 004 follow-up — gate 6 PASSED; Phase 0 verified

Documentation only; no source or build changes.

- `docs/PHASE0_RESULTS.md`: **gate 6 PASS** from the owner's live run
  (2026-09-20T00:34:44Z). `build-12` written, 6 files, version 23, 12.2 s, backup
  written first, test deployment repointed, stable untouched, and the Apps Script
  editor never opened — which is the gate. All six of the recorded fingerprint's
  digests match the ones `build-12`'s release manifest published, so the project
  is provably running the bytes CI built and tagged.
- The file is closed out: **all six gates pass**, each with the channel it was
  verified on (1–5 stable, 6 test, and why). Phase 0's remaining items are the
  `v0.0.0` tag and the Architect's `docs/reviews/phase-0.md`, neither of which is
  a gate and both of which ticket 004 puts out of scope.
- Recorded what the run did **not** cover, rather than letting a pass imply it:
  promotion to stable, backup pruning to ten, the deliberate-corruption check,
  and the missing-`testDeploymentId` message. All four are unit tested; none is
  part of gate 6's write path.
- `docs/SETUP.md`: four steps that exist only because ADR 0002 moved Keystone to
  a **standard** Cloud project, which auto-enables nothing the default hidden
  project used to do silently:
  - **6b** create the Cloud project and link the script to it (and the warning
    that doing so revokes every existing authorization);
  - **6c** configure the OAuth consent screen under Google Auth Platform →
    Branding;
  - **6d** add every Keystone user as a **test user** under Audience — in
    Testing mode an unlisted account cannot authorize at all;
  - **6e** enable the **Apps Script API and the Drive API separately**; missing
    the Drive one is what made `DriveApp` throw on a folder that opened fine in a
    browser.
  The old per-account Apps Script API toggle becomes 6f, with an explicit note
  that 6e and 6f are different switches and both are required.
- **Access control is now two lists that must agree** — Cloud test users and the
  `Users` tab — documented in 6d and cross-referenced from step 10, with the
  distinct failure each half produces: missing from `Users` gives Keystone's
  access screen and an `access_denied` log row; missing from the test-user list
  gives a Google error before any Keystone code runs, with nothing logged at all.
  That absence of a trace is how to tell them apart.
- Two troubleshooting entries for those failures, and the setup time estimate
  raised from 30 to 45 minutes.
