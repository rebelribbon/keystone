# Phase 0 verification gates — results

The six gates from SPEC §2.1. Gates 1, 2, and 4 are reported by the owner-only
`?dev=gates` route on the deployed test URL (ticket 002). Gates 3 and 6 arrive
with tickets 003 and 004.

**Fill in the rows below from your own `?dev=gates` run**, then attach the
screenshot. The Builder cannot deploy Apps Script from a cloud session, so the
values here must come from the deployed test URL, not from a local harness.

- Tag: _pending_
- Channel: _pending_
- Browser / OS: _pending_
- Date: _pending_

| Gate | Result | Measured | Notes |
|---|---|---|---|
| 1 — Loader | pending | _ms to first frame_ | Bundles load from jsDelivr at a `build-*` tag; budget 6000 ms. |
| 2 — Texture | pending | _canvas + PNG_ | Canvas-generated texture and `assets/test/checker.png` both render, no CORS error. |
| 3 — Round-trip | pending — ticket 003 | | 5 MB dummy build saves to Drive gzip + chunked and loads back byte-identical. |
| 4 — Storage | pending | _read-back_ | IndexedDB works inside the deployed iframe; FAIL selects the memory fallback for the thumbnail cache. |
| 5 — Release | PASS | `build-1` | Closed by ticket 001. Merging to `main` produced `build-1`, the `release` branch carries `dist/`, and jsDelivr serves `dist/client/engine.js` at the tag (HTTP 200). |
| 6 — Updater | pending — ticket 004 | | Sheet menu *Keystone → Update server code* overwrites the Apps Script files from a tag. |

A gate 4 FAIL is not a blocker. It selects the memory fallback for the thumbnail
cache later; record it and move on.

## Pre-deployment harness check (not a gate result)

Before handing ticket 002 over, the Builder rendered `src/server/Index.html`
through a local stand-in for `HtmlService` templating, served the real built
bundles over HTTP, and drove the page in headless Chromium. That run reported
gate 1 PASS (376 ms to first frame), gate 2 PASS (canvas 64 px + 64 px PNG, no
CORS error), and gate 4 PASS (byte-identical read-back).

**Those numbers are not the gate results.** They exercise the template and the
client code, not Apps Script, `HtmlService`, the iframe sandbox, or jsDelivr.
The rows above stay `pending` until the owner runs `?dev=gates` on the real
deployment.
