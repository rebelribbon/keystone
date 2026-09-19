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

