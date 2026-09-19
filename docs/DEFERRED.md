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
- **`api_getThumb` (§14.2)** — deferred from ticket 003. No thumbnail pipeline exists
  until Phase 4 (§13.3), so `thumbFileId` is always blank today. A getter for data
  nothing produces would ship untested and unexercised.
- **`api_duplicateBuild` (§14.2)** — deferred from ticket 003. It is only reachable
  from the builds gallery, which is Phase 1, and its naming and conflict behavior
  should be written against that screen rather than guessed ahead of it.
- **`api_exportCost` (§15)** — deferred from ticket 003. The cost engine is Phase 4.
- **Autosave, IndexedDB recovery copies, export/import, and screenshots (§14.3)** —
  deferred from ticket 003. All four serialize the Store, which does not exist until
  Phase 1. Gate 3 uses a dummy buffer precisely so the transport can be proven first.
- **Direct Drive fetch from the client (§14.2, load path)** — rejected in ticket 005.
  Handing the page an OAuth token from `ScriptApp.getOAuthToken()` would let it pull
  the `.ksb` in a single request and put load time in the low single-digit seconds,
  beating the chunk cache outright. It is rejected on the threat model, not the
  performance: the manifest carries the full `drive` scope, and the page's JavaScript
  is served from a public CDN at a tag anyone can read. A token with that scope in
  that page couples a repo compromise to a Drive compromise — every build, every
  family member, not just Keystone's own folder.
  Narrowing the manifest from `drive` to `drive.file` is the prerequisite if load time
  ever becomes the binding constraint again. That changes the manifest, the setup
  authorization prompt, and the threat model, so it is an ADR rather than an
  implementation decision. The chunk cache in 005 was taken instead because it needs
  none of that.

