# Phase 0 verification gates — results

The six gates from SPEC §2.1. Five pass. Only gate 6 (the updater, ticket 004)
is outstanding.

| Gate | Result | Measured | Notes |
|---|---|---|---|
| 1 — Loader | **PASS** | 109 ms to first frame | All bundles loaded from jsDelivr. Boot block at 84 ms. Budget 6000 ms. |
| 2 — Texture | **PASS** | canvas 64 px + 64 px PNG | Canvas-generated texture and `assets/test/checker.png` both rendered, no CORS error. |
| 3 — Round-trip | **PASS** | 5,242,880 bytes, digests match | 5 MB saved to Drive gzip + chunked and loaded back byte-identical. Detail below. |
| 4 — Storage | **PASS** | read-back byte-identical | IndexedDB works inside the deployed iframe, so the thumbnail cache does not need the memory fallback. |
| 5 — Release | **PASS** | `build-4` | Merging to `main` tags a build, the `release` branch carries `dist/`, and jsDelivr serves it with no manual step. |
| 6 — Updater | pending — ticket 004 | | Sheet menu *Keystone → Update server code* overwrites the Apps Script files from a tag. |

Gates 1, 2, 4, 5 were run at 2026-09-18T23:05:42.749Z on tag `build-4`.
Gate 3 was run at 2026-09-19T16:54:39Z on tag `build-6`. Both on the **stable**
channel.

Gate 1 came in at 109 ms against a 6000 ms budget — roughly 55x headroom. That
is the loader and the Phase 0 cube only; the real engine arrives in Phase 1.

Gate 4 passing means IndexedDB is available inside the `HtmlService` iframe, so
the thumbnail cache (§13.3) can use it rather than falling back to memory.

## Gate 3 — Drive round-trip, in detail

Owner's `?dev=gate3` run on the deployed stable URL, tag `build-6`,
2026-09-19T16:54:39Z.

| Measure | Value |
|---|---|
| Buffer size | 5,242,880 bytes |
| SHA-256 before gzip | `065ce6350937b564c88562c4fb60be579942f8732cb5a2d2e0e30a3184d374d7` |
| SHA-256 after gunzip | `065ce6350937b564c88562c4fb60be579942f8732cb5a2d2e0e30a3184d374d7` |
| Bytes read back | 5,242,880 |
| gzip size | 5,244,503 bytes |
| base64 size | 6,992,672 chars |
| Final chunk size | 100,000 chars |
| Chunk count | 70 |
| Upload attempts | 5 |
| **Save wall clock** | **68.2 s** |
| **Load wall clock** | **518.9 s** |
| Result | **PASS** — digests identical, test build soft-deleted |

The buffer is deterministic (xorshift32 from a fixed seed), so
`065ce635…84d374d7` is reproducible on any future run and can be compared
directly against this one.

The chunk ladder behaved as ticket 003 §7 predicted: four rejections at 1.5 MB,
750 KB, 375 KB and 187.5 KB, then success at the 100 KB floor, giving 70 chunks
and 5 upload attempts.

### Timings — before and after ticket 005

**Save: 68.2 s.** Under the 90 s threshold ticket 003 §7 set, so the escalation
it describes was never triggered. Unchanged by ticket 005, which does not touch
the save path.

**Load, before ticket 005: 518.9 s.** That is 8.6 minutes and **7.61x the save
over the same 70 chunks** — 7.41 s per chunk down against 0.97 s up. §7
anticipated the save being slow and said nothing about the load.

The cause was not Drive latency. `api_loadChunk` re-read the entire build file
from Drive and base64-encoded all of it on every call, then returned one
100 KB slice and discarded the rest: 364 MB read and encoded to deliver 5.2 MB,
scaling as the square of build size. Ticket 005 moves that work to
`api_loadBuildInfo`, which was already paying for the same pass and throwing it
away, and has it prime a per-chunk cache instead.

**Load, after ticket 005: _pending the owner's re-run._**

| | Before (003) | After (005) |
|---|---|---|
| Save wall clock | 68.2 s | _pending_ |
| Load wall clock | 518.9 s | _pending_ |
| Per-chunk save, median | 970 ms | _pending_ |
| Per-chunk load, median | 7,410 ms | _pending_ |
| Median load / median save | 7.61x | _pending_ (budget 1.5x) |
| Cache hits / misses on load | n/a | _pending_ |
| Evicted-chunk load time (`&evict=17`) | n/a | _pending_ |

Ticket 005 sets the bar as **median per-chunk load within 1.5x of median
per-chunk save**, and load wall clock under 120 s. A smaller total that still
costs seconds per chunk is not this defect fixed; it is this defect plus
another one, and the Handoff is required to say so.

## Which channel these were run on

**All five passing gates were verified on the stable deployment.** At the time
gates 1, 2 and 4 were run there was no usable test channel: the `/dev` URL
returns a Google Drive error page whenever the owner is signed into more than
one Google account, because Google rewrites the path to `/macros/u/N/s/...` and
the request never reaches `doGet`.

ADR 0001 removed `/dev` from the deployment model in response. The test channel
is now a second versioned `/exec` deployment selected by `?c=test`. Nothing in
the results above depends on the channel — they exercise the loader, the
renderer, the browser sandbox, and the Drive round trip, none of which differ
between the two — and the tag-resolution difference that does differ is what
gate 5 covers.
