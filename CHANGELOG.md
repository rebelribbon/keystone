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
