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

