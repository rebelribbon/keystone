# Phase 0 verification gates — results

The six gates from SPEC §2.1.

- Tag: `build-4`
- Channel: **stable**
- Loader mode: `cdn`
- Gates 1, 2, 4 run at: 2026-09-18T23:05:42.749Z

| Gate | Result | Measured | Notes |
|---|---|---|---|
| 1 — Loader | **PASS** | 109 ms to first frame | All bundles loaded from jsDelivr. Boot block at 84 ms. Budget 6000 ms. |
| 2 — Texture | **PASS** | canvas 64 px + 64 px PNG | Canvas-generated texture and `assets/test/checker.png` both rendered, no CORS error. |
| 3 — Round-trip | pending — owner's `?dev=gate3` run | | 5 MB dummy build, gzip + chunked to Drive, SHA-256 compared before gzip and after gunzip. |
| 4 — Storage | **PASS** | read-back byte-identical | IndexedDB works inside the deployed iframe, so the thumbnail cache does not need the memory fallback. |
| 5 — Release | **PASS** | `build-4` | The page loaded its bundles from `build-4`. Merging to `main` tags a build, the `release` branch carries `dist/`, and jsDelivr serves it with no manual step. |
| 6 — Updater | pending — ticket 004 | | Sheet menu *Keystone → Update server code* overwrites the Apps Script files from a tag. |

Gate 1 came in at 109 ms against a 6000 ms budget — roughly 55x headroom. That
is the loader and the Phase 0 cube only; the real engine arrives in Phase 1.

Gate 4 passing means IndexedDB is available inside the `HtmlService` iframe, so
the thumbnail cache (§13.3) can use it rather than falling back to memory.

## Which channel these were run on

**Gates 1, 2, 4, and 5 were all verified on the stable deployment, not the test
one.** At the time there was no usable test channel: the `/dev` URL returns a
Google Drive error page whenever the owner is signed into more than one Google
account, because Google rewrites the path to `/macros/u/N/s/...` and the request
never reaches `doGet`.

ADR 0001 removed `/dev` from the deployment model in response. The test channel
is now a second versioned `/exec` deployment selected by `?c=test`. Nothing in
the gate results above depends on the channel — they exercise the loader, the
renderer, and the browser sandbox, none of which differ between the two — and
the tag-resolution difference that does differ is what gate 5 covers.

Re-running gates 1, 2, and 4 on the test deployment once it exists is worthwhile
confirmation but is not expected to change any result.

## Gate 3 — fill in from the `?dev=gate3` run

Open either deployment URL with `?dev=gate3` as the owner and transcribe the
panel. The harness generates a deterministic 5 MB buffer from a fixed seed, so
the "SHA-256 before gzip" value is reproducible across runs and machines.

| Measure | Value |
|---|---|
| Buffer size | _pending_ |
| SHA-256 before gzip | _pending_ |
| gzip size | _pending_ |
| base64 size | _pending_ |
| Final chunk size | _pending_ |
| Chunk count | _pending_ |
| Upload attempts | _pending_ |
| Save wall clock | _pending_ |
| Load wall clock | _pending_ |
| SHA-256 after gunzip | _pending_ |
| Gate 3 | _pending_ |

Ticket 003 §7 asks for the save time to be reported either way, and for the
Architect to be told if a 5 MB save exceeds 90 seconds.

## Pre-deployment harness check (not a gate result)

Before handing ticket 003 over, the Builder ran the gate 3 flow against the real
`Api.gs`, `Storage.gs`, and `Code.gs` evaluated in a Node sandbox with in-memory
stand-ins for `SpreadsheetApp`, `CacheService`, `DriveApp`, `LockService`,
`Utilities`, and `Session`, driven by the real client transport in headless
Chromium. That run reported PASS: 5,242,880 bytes in, SHA-256
`065ce635...84d374d7` matching on both sides, gzip 5,244,503 bytes, base64
6,992,672 characters, 70 chunks of 100,000 characters after 5 upload attempts.

**Those numbers are not the gate result.** The stand-ins are local and
in-process: they do not measure `google.script.run` round-trip latency, which is
the entire point of the §7 timing risk, and 0.8 s of local save time says
nothing about what Apps Script will take. The table above stays `pending` until
the owner runs `?dev=gate3` on a real deployment.
