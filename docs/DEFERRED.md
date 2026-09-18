# Deferred

Cuts made intentionally, with the reason. (Hard rule: no shipped TODOs — cuts go here.)

- **Full `registerPack` validation (§10.2)** — deferred from ticket 001. Ticket 001
  implements only store-by-id, duplicate-id throw, and non-object/missing-id reject.
  Semver checks, `requires` resolution, per-item schema validation, and the
  dev-vs-prod duplicate behavior land with the ticket that first ships real catalog
  content, so validation is written against actual `MaterialDef`/`CatalogItem` data.
- **Render on demand (§4.2)** — deferred from ticket 001. The Phase 0 boot cube uses a
  continuous `requestAnimationFrame` loop because there is no store or camera-change
  signal to render against yet. Render-on-demand arrives with the real engine in
  Phase 1.
- **Automatic detection of a blocked external script (§2.1 gate 1 fallback)** — deferred
  from ticket 002. The jsDelivr fallback is an explicit `Settings` key, `loader_mode`,
  taking `cdn` (default) or `inline`; it is not detected at runtime. The reliable
  signals for "HtmlService blocked this script tag" are all timing heuristics, and a
  wrong guess doubles load time on every page view. If gate 1 fails on `cdn`, the owner
  flips one cell and re-tests.

