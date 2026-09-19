# Phase 0 verification gates — results

The six gates from SPEC §2.1. Gates 1, 2, and 4 come from the owner-only
`?dev=gates` route on the deployed web app (ticket 002). Gate 5 was closed by
ticket 001. Gates 3 and 6 arrive with tickets 003 and 004.

- Tag: `build-4`
- Channel: `stable`
- Loader mode: `cdn`
- Run at: 2026-09-18T23:05:42.749Z

| Gate | Result | Measured | Notes |
|---|---|---|---|
| 1 — Loader | **PASS** | 109 ms to first frame | All bundles loaded from jsDelivr. Boot block at 84 ms. Budget 6000 ms. |
| 2 — Texture | **PASS** | canvas 64 px + 64 px PNG | Canvas-generated texture and `assets/test/checker.png` both rendered, no CORS error. |
| 3 — Round-trip | pending — ticket 003 | | 5 MB dummy build saves to Drive gzip + chunked and loads back byte-identical. |
| 4 — Storage | **PASS** | read-back byte-identical | IndexedDB works inside the deployed iframe, so the thumbnail cache does not need the memory fallback. |
| 5 — Release | **PASS** | `build-4` | The page loaded its bundles from `build-4`. Merging to `main` tags a build, the `release` branch carries `dist/`, and jsDelivr serves it with no manual step. |
| 6 — Updater | pending — ticket 004 | | Sheet menu *Keystone → Update server code* overwrites the Apps Script files from a tag. |

Gate 1 came in at 109 ms against a 6000 ms budget — roughly 55x headroom. That
is the loader and the Phase 0 cube only; the real engine arrives in Phase 1.

Gate 4 passing means IndexedDB is available inside the `HtmlService` iframe, so
the thumbnail cache (§13.3) can use it rather than falling back to memory.

## Note on the channel

These gates were run on the **stable** deployment, not the test one. Both
deployments run the same server code and the same client bundles; the only
difference is how the tag is resolved (`stable_tag` from `Settings` versus the
newest `build-*` from the GitHub Releases API). Gates 1, 2, and 4 exercise the
loader, the renderer, and the browser sandbox, none of which differ by channel,
so the results hold for both. The tag-resolution difference is what gate 5
covers, and it passed on `build-4`.
