# Phase 0 verification gates — results

The six gates from SPEC §2.1. Five pass. Only gate 6 (the updater, ticket 004)
is outstanding.

| Gate | Result | Measured | Notes |
|---|---|---|---|
| 1 — Loader | **PASS** | 109 ms to first frame | All bundles loaded from jsDelivr. Boot block at 84 ms. Budget 6000 ms. |
| 2 — Texture | **PASS** | canvas 64 px + 64 px PNG | Canvas-generated texture and `assets/test/checker.png` both rendered, no CORS error. |
| 3 — Round-trip | **PASS** | 5,242,880 bytes, digests match | 5 MB saved to Drive gzip + chunked and loaded back byte-identical. Load 518.9 s → 48.3 s after ticket 005. Detail below. |
| 4 — Storage | **PASS** | read-back byte-identical | IndexedDB works inside the deployed iframe, so the thumbnail cache does not need the memory fallback. |
| 5 — Release | **PASS** | `build-4` | Merging to `main` tags a build, the `release` branch carries `dist/`, and jsDelivr serves it with no manual step. |
| 6 — Updater | pending — ticket 004 live run | | Sheet menu *Keystone → Update server code* writes `dist/server/*` from a tag, creates a version, and repoints the test deployment. Code landed in ticket 004; the owner's live run fills this row. |

Gates 1, 2, 4, 5 were run at 2026-09-18T23:05:42.749Z on tag `build-4`.
Gate 3 was first run at 2026-09-19T16:54:39Z on tag `build-6` and re-run twice
at 2026-09-19T22:39:00Z and 2026-09-19T22:43:08Z on tag `build-9` after ticket
005. All on the **stable** channel.

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
directly against this one. Both `build-9` re-runs below produced the same two
digests, so all three runs moved the same bytes.

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

**Load, after ticket 005: 48.3 s — 10.7x faster.** Both of ticket 005's
acceptance thresholds are met, so the diagnosis above was complete.

Two `build-9` re-runs, both PASS, both digest-matching:

| | Before (003, `build-6`) | After (005, `build-9`) | After, one chunk evicted |
|---|---|---|---|
| Run | 16:54:39Z | 22:39:00Z | 22:43:08Z (`&evict=17`) |
| Save wall clock | 68.2 s | 70.8 s | 68.2 s |
| Load wall clock | 518.9 s | **48.3 s** | 57.3 s |
| Per-chunk save min/median/max | — / 970 ms† / — | 480 / **672** / 1388 ms | 465 / 682 / 1169 ms |
| Per-chunk load min/median/max | — / 7,410 ms† / — | 410 / **542** / 976 ms | 460 / 594 / 4492 ms |
| Median load ÷ median save | 7.61x† | **0.81x** | 0.87x |
| Cache hits / misses on load | n/a | 70 / 0 | 69 / 1 |
| Evicted-chunk load time | n/a | n/a | 4492 ms (chunk 17) |
| Result | PASS | **PASS** | **PASS** |

Budget: median load within **1.5x** of median save, and load wall clock under
**120 s**. Both re-runs clear both, with the ratio under 1.0 — the load is now
marginally *faster* per chunk than the save.

† The `build-6` per-chunk figures are wall clock ÷ 70, i.e. means. Ticket 003's
harness did not record per-chunk distributions; ticket 005 added them. The
like-for-like comparison across the two runs is therefore mean-to-mean:
**7,412.9 ms → 690.0 ms per chunk on load, 10.7x.** The 0.81x figure is a
within-run measurement against the acceptance budget, not a before/after ratio.
Mixing the two would flatter the result.

### What the eviction run shows

`&evict=17` drops one primed chunk from `CacheService` mid-load, so the
`api_loadChunk` cold path runs exactly once in an otherwise warm load. That one
chunk cost **4492 ms** — it is the run's `max`, 7.6x its own median — because a
miss re-reads and re-primes the whole file. The cost is real and it is bounded:
one miss costs one re-prime, not 70, and even that single cold chunk came back
faster than the 7,412.9 ms per-chunk mean every chunk paid before ticket 005.

The run's load wall clock is 9.0 s above the warm run. About 4.5 s of that is
the miss itself; the rest is run-to-run variance — the warm median moved 542 →
594 ms between the two runs, which is 3.6 s across 70 chunks. Two runs is not
a distribution, so treat the gap as "one miss plus noise," not a measured
eviction penalty of 9 s.

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

Gate 6 is the exception by design: it is the first gate that must be run on
**test**, because repointing the test deployment is what it does. Its row above
records the channel with the rest of its figures once the owner runs it.
