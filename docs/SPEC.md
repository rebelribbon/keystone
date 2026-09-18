# KEYSTONE — Master Build Spec
Working name: **Keystone**. A browser-based 3D home design tool with the build-mode feel of a life-sim builder, served as a Google Apps Script web app.

Spec version: 1.1 (zero-install deploy) · Status: LOCKED for Phase 0–2 · Owner: Architect

---

## 0. Rules for every AI working on this project

1. This document is the source of truth. If code and spec disagree, the spec wins until the Architect changes the spec.
2. Never change a data schema (Section 6), the registry format (Section 10), or a file name (Section 3) without a spec update first. Schema changes bump `SCHEMA_VERSION` and ship a migration.
3. Every state mutation goes through a Command (Section 7). No tool, UI panel, or catalog item writes to state directly.
4. Engine code never contains content. Content files never contain engine logic. Content only registers data and geometry builders.
5. No EA / Maxis / Sims names, icons, sounds, fonts, UI art, or assets anywhere, including comments and asset file names. We replicate mechanics and feel only.
6. No placeholder "TODO: implement later" shipped in a phase marked done. If something is cut, it goes in `docs/DEFERRED.md` with a reason.
7. Units in code are meters and radians. Display units are a user setting.
8. Every PR/change set updates `CHANGELOG.md` and lists which spec sections it touches.

---

## 1. Product definition

### 1.1 Goal
A full-featured, beautiful exterior home builder that feels like a top-tier life-sim build mode: drag walls, drop rooms, push/pull rooms, adjustable foundations, handle-driven roofs, click-to-paint, a deep catalog filtered by architectural style, and a camera that feels effortless. Real-world cost estimates run live as you build.

### 1.2 Scope v1 (ships)
- Engine supports interiors fully (two-sided walls, rooms, levels, floors, ceilings).
- Content ships exterior only: siding and masonry, roofs, windows, doors, garage doors, columns, porches, decks, stairs, railings, trim, fences, landscaping, pools, exterior lighting, terrain.
- 70+ architectural styles as catalog filters, palettes, and one-click starter shells.

### 1.3 Deferred (patches)
- Patch A "Interiors": furniture, appliances, fixtures, interior doors, wallpaper, interior flooring, ceilings, interior lighting.
- Patch B "Sculpting": roof sculpting, curved walls, custom foundations shapes beyond grid.
- Patch C "Neighborhood": multiple lots, streets, lot templates.

### 1.4 Non-goals
Characters, simulation, gameplay, multiplayer real-time editing, mobile touch-first editing (mobile gets view-only gallery in v1).

### 1.5 Quality bar
- 60 fps on a mid-range laptop (integrated GPU, 2022+) with a 40×40 lot, 2 levels, 3,000 placed objects, shadows on.
- First meaningful render under 6 seconds on a normal home connection.
- Zero data loss: autosave, versioned saves, missing-content placeholders instead of dropping items.
- Every interaction has a visible preview before commit and is undoable.

---

## 2. Locked technical decisions

| Area | Decision | Why |
|---|---|---|
| Hosting | Google Apps Script web app (`HtmlService`, IFRAME mode) | Required by owner |
| 3D | Three.js `three@0.170.0` from npm, bundled | Current API, no CDN dependency for core |
| Language | Modern JavaScript (ES2022) with JSDoc types | No TypeScript compile friction in Apps Script; JSDoc gives editor checking |
| Build | `esbuild` bundles `src/client` into IIFE `.js` bundles in `dist/client/`; runs only in cloud (Claude Code cloud sessions and GitHub Actions) | Owner's PC cannot install software |
| Deploy | **Loader model:** a small Apps Script project serves `Index.html`, which loads the client bundles from jsDelivr at a pinned release tag. Releasing = GitHub Action tags a build; owner picks the tag in the Settings sheet | No local tools, no pasting large files, instant rollback |
| Repo | GitHub, **public** `keystone` repo (required for jsDelivr). Assets live in the same repo under `assets/` | Free, zero setup. Switch path to private source is in §2.3 |
| Save storage | Google Drive: one gzip file per build | Sheets cells cap at 50,000 chars |
| Index | Google Sheet: `Builds`, `Settings`, `Users`, `Log` tabs | Human-readable admin view |
| Textures | Procedural canvas generation at runtime (default) | Nothing to host, infinite recolors |
| Heavy assets | `assets/` folder in the same repo, served via jsDelivr at the release tag | CORS-clean, fast, free |
| Tests | `vitest` for pure logic, run by Claude Code in its cloud session and by GitHub Actions on every PR | Catch geometry regressions fast |
| Builder runtime | Claude Code cloud sessions (Claude desktop app Code tab or claude.ai/code) | Nothing installed on the owner's PC |
| Fonts | Manrope via Google Fonts, system fallback | Clean UI, tabular numerals for costs |

### 2.1 Phase 0 verification gates (must pass before Phase 1)
1. **Loader gate:** the deployed web app loads `vendor-three.js` and `engine.js` from jsDelivr at a release tag and shows a lit, shadowed, spinning cube. First render under 6 s. Fallback if HtmlService blocks external scripts: Apps Script fetches the bundles server-side with `UrlFetchApp`, caches them in `CacheService` (chunked), and inlines them into the page.
2. **Texture gate:** a canvas-generated texture and a jsDelivr-hosted PNG from `assets/` both render without CORS errors.
3. **Round-trip gate:** a 5 MB dummy build saves to Drive (gzip + chunked) and loads back byte-identical.
4. **Storage gate:** IndexedDB works inside the deployed iframe. If blocked, thumbnail cache falls back to memory.
5. **Release gate:** merging to `main` triggers the GitHub Action, which runs tests, builds, commits `dist/` to the `release` branch, and creates tag `build-<run number>`. The new tag is live on the test URL within 2 minutes without anyone touching Apps Script.
6. **Updater gate:** the Sheet menu *Keystone → Update server code* pulls `dist/server/*` from the chosen tag and overwrites the Apps Script project files through the Apps Script API. Fallback: owner (or Claude in Chrome) pastes the server files into the Apps Script editor. Server files stay small on purpose.

Record results in `docs/PHASE0_RESULTS.md`.

### 2.2 Deployment settings
- The Apps Script project is **bound to the Keystone Index Sheet** (Extensions → Apps Script), so the Sheet menu and the web app share one project.
- Manifest scopes: spreadsheets, drive, script.external_request, script.projects (updater), userinfo.email.
- Two web app deployments:
  - **Test:** the `/dev` URL (always runs the latest server code). Client version = newest `build-*` tag, looked up from the GitHub Releases API and cached 60 s.
  - **Stable:** a versioned deployment. Client version = `stable_tag` in the Settings sheet. Rollback = change that cell.
- Execute as: **User accessing the web app**. Who has access: **Anyone with a Google account**.
- The index Sheet and the Builds folder are shared (Editor) with each approved family member.
- Server checks `Session.getActiveUser().getEmail()` against the `Users` tab on every call. Not on the list: access screen.

### 2.3 Going private later
`asset_base_url` in Settings controls where bundles load from (default `https://cdn.jsdelivr.net/gh/<owner>/keystone@{tag}`). To keep source private: make the repo private, upgrade to a GitHub plan that allows Pages from private repos, have the Action publish minified bundles to Pages under `/builds/{tag}/`, and point `asset_base_url` there. Minified bundles stay publicly fetchable either way; source code does not. No code changes required.

---

## 3. Repository and file structure

```
keystone/
  CLAUDE.md                  # Builder instructions (points here)
  CHANGELOG.md
  .github/workflows/
    ci.yml                   # PRs: install, test, build
    release.yml              # main: test, build, commit dist to `release` branch, tag build-N, GitHub Release
  docs/
    SPEC.md                  # this file
    DEFERRED.md
    PHASE0_RESULTS.md
    SETUP.md                 # owner's one-time setup, click by click
    tickets/                 # Architect-written task tickets
    decisions/               # ADRs: one file per locked decision change
    reviews/  qa/
  src/
    server/                  # Apps Script code (plain .gs-compatible JS, no bundling)
      Code.gs                # doGet, include(), auth, channel/tag resolution, onOpen menu
      Api.gs                 # §14 functions
      Storage.gs             # Drive + Sheet helpers
      Updater.gs             # pulls dist/server from a tag, writes via Apps Script API
      Index.html             # loader shell (template)
      appsscript.json
    client/
      core/ engine/ geometry/ materials/ tools/ ui/ persistence/ cost/ registry/
      main.js
    content/
      styles/ exterior/ materials/ interior/
  assets/                    # optional PNG/GLB assets, served by jsDelivr
  build/
    build.mjs                # esbuild -> dist/
  dist/                      # generated by CI only, committed on the `release` branch, never on main
    server/                  # copied verbatim from src/server
    client/
      styles.css
      vendor-three.js        # window.THREE
      engine.js              # window.KS (core, engine, geometry, tools, ui, persistence, cost, registry)
      catalog-materials.js
      catalog-styles.js
      catalog-exterior.js
      catalog-interior.js    # stub in v1
    manifest.json            # tag, commit, build time, file list with sizes and SHA-256
  tests/
  package.json
```

### 3.1 Load order (`Index.html`)
`Code.gs` resolves `{tag}` (test = newest build tag, stable = `stable_tag`) and `asset_base_url`, then the template emits, in order:
1. `<link rel="stylesheet" href="{base}/dist/client/styles.css">` and the Manrope font link
2. `vendor-three.js` → `window.THREE`
3. `engine.js` → `window.KS` with an empty `KS.registry`
4. `catalog-materials.js`, `catalog-styles.js`, `catalog-exterior.js`, `catalog-interior.js`
5. Inline boot: `KS.boot({ tag, channel, user })`

All script tags use `defer` to keep order. A loading screen shows progress per file. If a file fails, the screen names the file and tag and offers "Try the previous build."

Each catalog bundle only calls `KS.registry.registerPack(...)` (§10). Adding a patch = add a new `src/content/<pack>` entry point, one line in `build.mjs`, one line in the loader list. No engine changes.

### 3.2 Updating
- **Client changes (almost all work):** merge PR → Action releases `build-N` → live on test URL → owner tests → owner sets `stable_tag` = `build-N` in Settings.
- **Server changes (rare):** after release, owner clicks *Keystone → Update server code* in the Sheet, picks the tag. For stable, owner then creates a new version under Deploy → Manage deployments (Claude in Chrome can do this).

## 4. Architecture

```
 UI (panels, catalog, toolbars)
   │  user intent
   ▼
 Tools (wall, room, roof, paint, ...) ──► preview objects (not in state)
   │  on commit
   ▼
 Commands (do / undo / merge) ──► Store (single source of truth)
                                     │ emits change events with dirty keys
                                     ▼
                       Builders (geometry from state) ──► Scene graph ──► Renderer
                                     ▲
                       Registry (catalog items, materials, styles)
 Persistence  ◄── serialize Store ── Autosave / Save
 Cost engine  ◄── subscribes to Store changes
```

### 4.1 Core modules
- **Store** (`core/store.js`): holds the Build document (Section 6). Immutable-style updates by path. Emits `change` events with a set of dirty entity IDs and dirty categories (`walls`, `roofs`, `terrain`, ...).
- **Command bus** (`core/commands.js`): executes commands, maintains undo/redo stacks (unlimited within session, capped at 500 entries in memory), supports merging (e.g., continuous terrain brush strokes merge into one undo step), and transaction grouping (`beginGroup/endGroup`).
- **Event bus** (`core/events.js`): typed events `tool:changed`, `level:changed`, `view:changed`, `selection:changed`, `build:saved`, etc.
- **Scene sync** (`engine/sync.js`): on store change, rebuilds only dirty entities. Walls rebuild per affected wall-graph node neighborhood, not whole level.
- **Picking** (`engine/picking.js`): GPU-free raycasting against simplified pick meshes (wall faces, floor tiles, terrain, object bounding boxes). Returns `{entityType, entityId, face, point, normal, tile}`.

### 4.2 Performance rules
- Repeated catalog objects render as `InstancedMesh` grouped by `(itemId, variantId, lod)`.
- Walls, floors, and foundations merge into one mesh per `(level, materialId)` after edits settle (debounce 150 ms). During drag, only affected meshes rebuild.
- Trees and shrubs have 3 LODs plus a billboard impostor beyond 60 m.
- Shadow map 2048 (high), 1024 (medium), off (low). Shadow camera frustum fits the lot bounds.
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`, lowered automatically if frame time > 20 ms for 2 s.
- Render on demand: only render when the camera moves, state changes, or a time-of-day animation runs.
- Texture cache keyed by `materialId|variant|tint|size`. Dispose unused GPU resources on level change and on load.

---

## 5. Coordinates, units, grid

- Right-handed, **Y up**. Lot origin (0,0,0) at the lot's southwest corner at base terrain height. +X = east, +Z = south (Three.js default), north = −Z.
- **1 tile = 1.0 m.** Lot sizes (tiles): 20×15, 20×20, 30×20, 30×30, 40×30, 40×40, 50×50, 64×64.
- Snap modes: full tile, half tile (default for walls), quarter tile (floors), free (hold `Alt`).
- Wall thickness: 0.15 m. Wall centerline sits on grid lines.
- Wall heights: Short 2.74 m (9 ft), Medium 3.05 m (10 ft), Tall 3.66 m (12 ft). Per level setting, per-wall override allowed.
- Foundation heights: 0 (slab), 0.25 m, 0.5 m, 0.75 m, 1.0 m, 1.5 m, 2.0 m, plus free value 0–3 m.
- Rotation: 45° steps; `Alt` for free 15° steps; `Alt+Shift` for free rotation.
- Level elevation = foundation height + sum of lower level heights + floor thickness (0.25 m).
- Max levels: 1 basement (Patch B) + 4 above ground.
- Display units: Imperial (default) or Metric. All cost math uses square feet internally converted from m² (1 m² = 10.7639 ft²).

---

## 6. Data model (Build document)

`SCHEMA_VERSION = 1`. All IDs are short random strings prefixed by type (`w_`, `n_`, `r_`, `o_`, `rf_`...). Content references are stable catalog IDs (Section 10.3).

```json
{
  "schema": 1,
  "meta": {
    "id": "b_7Hq2kd",
    "name": "Hill Country Build 1",
    "owner": "someone@gmail.com",
    "created": "2026-09-16T15:00:00Z",
    "updated": "2026-09-16T16:30:00Z",
    "primaryStyle": "style.spanish.texas_hill_country",
    "packs": { "core.materials": "1.0.0", "core.exterior": "1.0.0", "core.styles": "1.0.0" },
    "units": "imperial",
    "regionCostMultiplier": 1.0
  },
  "lot": {
    "size": [40, 30],
    "orientationDeg": 0,
    "environment": { "timeOfDay": 16.5, "latitude": 30, "season": "summer", "skyPreset": "clear" },
    "terrain": {
      "resolution": 2,
      "heights": "<base64 Float32Array, (sizeX*res+1)*(sizeZ*res+1)>",
      "paint": {
        "layers": ["terrain.grass_lush", "terrain.dirt", "terrain.gravel", "terrain.sand"],
        "splat": "<base64 Uint8Array RGBA, 4 px per tile>"
      }
    }
  },
  "levels": [
    {
      "id": "lv_0",
      "index": 0,
      "wallHeight": 3.05,
      "foundation": { "type": "raised", "height": 0.5, "materialId": "mat.stone.limestone_ashlar" },
      "nodes": { "n_a": [2, 2], "n_b": [14, 2] },
      "walls": {
        "w_1": {
          "a": "n_a", "b": "n_b",
          "height": null,
          "kind": "full",
          "sideLeft":  { "materialId": "mat.stucco.hand_troweled", "tint": "#EFE6D8" },
          "sideRight": { "materialId": "mat.plaster.smooth", "tint": null },
          "openings": ["op_1"]
        }
      },
      "rooms": {
        "r_1": { "polygon": [[2,2],[14,2],[14,10],[2,10]], "name": "", "isExterior": false,
                 "floorMaterialId": null, "ceilingMaterialId": null }
      },
      "floorTiles": {
        "<tileX>,<tileZ>": { "q": ["mat.paver.saltillo", null, null, "mat.paver.saltillo"] }
      },
      "platforms": {},
      "openings": {
        "op_1": { "itemId": "ext.window.casement_iron_tall", "variant": "black",
                  "wallId": "w_1", "t": 0.35, "sill": 0.6, "flip": false }
      },
      "fences": {},
      "stairs": {},
      "trim": {
        "spandrel": { "itemId": "ext.trim.spandrel_stucco_band", "variant": "cream" },
        "frieze":   null,
        "foundationTrim": null
      }
    }
  ],
  "roofs": {
    "rf_1": {
      "type": "hip",
      "levelId": "lv_0",
      "footprint": { "mode": "rect", "center": [8, 6], "size": [14, 10], "rotation": 0 },
      "pitchDeg": 22.6,
      "overhang": 0.6,
      "fascia": 0.2,
      "gableFill": "auto",
      "materialTop": { "materialId": "mat.roof.clay_barrel", "tint": "#B5552F" },
      "materialUnder": { "materialId": "mat.wood.soffit_tongue_groove", "tint": null },
      "trimId": "ext.roof_trim.clay_ridge",
      "gutters": { "itemId": "ext.gutter.copper_half_round", "sides": [true, true, true, true] },
      "heightOffset": 0
    }
  },
  "objects": {
    "o_1": { "itemId": "ext.tree.live_oak_mature", "variant": "default",
             "pos": [30, 0, 22], "rotY": 0.0, "scale": 1.0, "levelId": null, "surface": "terrain" }
  },
  "paths": {},
  "pools": {},
  "camera": { "target": [20, 0, 15], "distance": 38, "yaw": 0.78, "pitch": 0.62, "levelIndex": 0, "wallMode": "cutaway" }
}
```

### 6.1 Wall graph rules
- Walls are edges between nodes on a level. A new wall that crosses or touches an existing wall **splits** both at the intersection and shares the node.
- Collinear walls meeting at a node with only two edges and identical properties **merge** automatically after commit.
- `sideLeft` / `sideRight` are relative to the direction a→b (left = +90° CCW from the a→b vector when viewed from above).
- `kind`: `full`, `half` (1.1 m), `spandrel-only` (reserved), `fence-wall` (reserved).
- Openings belong to one wall and store `t` (0–1 along the wall centerline at the opening's center) and `sill` (bottom height). When a wall splits, openings are reassigned to the segment containing them. Openings that no longer fit are removed and reported in a toast (the command stays undoable).

### 6.2 Room detection
- After every wall change, the level's wall graph is converted to a planar graph and faces are found by half-edge traversal (always turn most-clockwise).
- Bounded faces with area ≥ 1 m² become rooms. The unbounded face is the exterior.
- Room identity is preserved across recomputes by maximum polygon overlap (IoU ≥ 0.5 keeps the old ID and its properties).
- Each wall side learns which room it faces (`roomLeft`, `roomRight`, runtime only, not saved). Exterior-facing sides are the ones the exterior paint tool targets and the ones counted as siding in cost.

### 6.3 Floor tiles
- Keyed per tile per level, 4 quarters in order NW, NE, SE, SW. Diagonal half-tile triangles are stored as quarter pairs.
- Rooms auto-fill floor (interior material default) when created. Exterior tiles are used for patios, porches, decks, and upper-level balconies. A floor tile on an upper level with no room is a balcony/deck and needs support (wall, column, or lower room) or it shows a warning (never blocks placement).

### 6.4 Save format
- JSON → UTF-8 → gzip (`CompressionStream`) → base64 → chunks of 1.5 MB → server.
- Server writes one Drive file `<buildId>.ksb` (gzip bytes) in the Builds folder, plus a thumbnail `<buildId>.jpg`.
- Migrations: `persistence/migrations.js` exports `{ from: n, to: n+1, migrate(doc) }`. Loader runs migrations in order before touching the store.
- Unknown `itemId` on load: keep the data untouched, render a labeled grey placeholder box sized from the saved footprint (objects store `bbox` cache for this reason), and list missing packs in a banner.

---

## 7. Commands and undo

```js
/** @typedef {{ type:string, label:string, do(store):void, undo(store):void, merge?(next):boolean }} Command */
KS.commands.run(cmd)          // executes, pushes to undo stack, clears redo
KS.commands.group(label, fn)  // all commands inside become one undo step
KS.commands.undo() / redo()
```

Required commands (v1): `AddWalls`, `DeleteWalls`, `MoveNode`, `SetWallProps`, `PaintWallSide`, `PaintRoomSides`, `AddRoomRect`, `PushPullRoomWall`, `MoveRoom`, `RotateRoom`, `SetFoundation`, `PaintFloorTiles`, `AddRoof`, `EditRoof`, `DeleteRoof`, `AddOpening`, `MoveOpening`, `DeleteOpening`, `PlaceObject`, `MoveObject`, `RotateObject`, `DeleteObjects`, `SetVariant`, `TerrainSculpt` (mergeable), `TerrainPaint` (mergeable), `AddFence`, `AddStairs`, `AddPath`, `AddPool`, `EditPool`, `SetTrim`, `SetLevelProps`, `ApplyStyleShell`, `SetEnvironment` (not undoable, but recorded).

Undo labels show in the UI history list ("Painted 4 walls", "Moved room").

---

## 8. Rendering

### 8.1 Renderer setup
- `WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, exposure 1.0 (auto-adjust with time of day).
- `shadowMap.type = PCFSoftShadowMap`.
- Lights: one `DirectionalLight` (sun, casts shadows), one `HemisphereLight` (sky/ground bounce), subtle `AmbientLight` at night for readability.
- Sky: custom shader dome (gradient + sun disc + horizon haze) driven by time of day. Night: deep blue gradient, stars as points.
- Ground outside the lot: large low-detail terrain ring with neutral grass, fog to horizon.
- Optional post (High preset): SSAO (`SAOPass` or N8AO-equivalent written in-house), FXAA fallback when MSAA unavailable. Post is a setting, off on Low.

### 8.2 Sun position
Computed from `timeOfDay` (0–24), `latitude`, `season` (solstice/equinox approximation), and `lot.orientationDeg`. Time-of-day slider in the top bar with play button (1 in-game hour per second).

### 8.3 Graphics presets
| Preset | Shadows | Post | Pixel ratio cap | Texture size |
|---|---|---|---|---|
| Low | off | off | 1 | 512 |
| Medium | 1024 | off | 1.5 | 1024 |
| High | 2048 | SSAO | 2 | 1024 (2048 for hero materials) |

### 8.4 Wall view modes (`camera.wallMode`)
- **Walls up:** all walls full height.
- **Cutaway (default):** a wall is cut to 0.45 m (showing a cap strip) when its facing side points toward the camera **and** the wall sits between the camera and the build's footprint centroid on the current level. Recomputed when the camera yaw changes by more than 5°.
- **Walls down:** all walls on the active level at 0.45 m.
- In exterior-only v1, cutaway still matters for porches, courtyards, and seeing roofs from inside the lot; default for new builds is **Walls up**.

### 8.5 Level visibility
Active level and below are visible. Levels above are hidden, including roofs whose base is above the active level. Toggle "show all levels" in the top bar. Roofs can be hidden with the `R` view toggle.

---

## 9. Geometry systems

### 9.1 Walls
- For each node, compute miter joins between all connected walls (sorted by angle). Wall side faces are built as 2D shapes in wall-local space (u along wall, v up) with **holes for openings**, triangulated via `THREE.ShapeGeometry` (earcut).
- Opening holes use the item's `cutProfile` (rectangle, round-top arch, pointed arch, segmental arch, circle, custom polyline).
- Reveal (jamb) faces are generated around each hole using the wall thickness, textured with the side's material (exterior half) and interior material (interior half).
- Wall top cap: thin strip mesh, trim-colored.
- Gable infill: if `roof.gableFill = "auto"`, gable-end triangles above a wall are filled with that wall's outside material.
- UVs: world-scale (1 UV unit = 1 m) so textures line up across wall segments and levels. Material definitions set their own real-world repeat size.

### 9.2 Foundations and platforms
- Foundation follows the level-0 footprint (union of rooms plus exterior floor tiles marked `onFoundation`). Types: slab, raised, pier-and-beam (visible piers + lattice skirt option), stem wall.
- Foundation side faces use foundation material; top edge gets optional trim.
- Entry steps auto-generate at exterior doors on raised foundations (toggle per door), using the door's style-matching stair item.
- Platforms: drag rectangle on any level, height 0–1.5 m, own material, auto-steps optional.

### 9.3 Roofs
Types v1: `gable`, `hip`, `shed`, `gambrel`, `mansard`, `flat` (with parapet option), `dutch_gable`, `pyramid`, `octagonal`, `dome`, `a_frame` (steep gable preset), `butterfly`, `jerkinhead` (clipped gable), `saltbox` (asymmetric gable).

- **Rect mode:** parametric generator per type from center, size, rotation, pitch, overhang, asymmetry (saltbox/shed).
- **Auto-roof mode:** select a level (or rooms) → generate from the footprint polygon using a **straight skeleton** (hip base). Gable variant converts selected skeleton faces to vertical gable ends. Must handle orthogonal polygons with 45° edges (L, T, U, courtyard shapes). Courtyards produce inward-sloping faces correctly.
- **Handles (rect mode):** edge handles resize, top handle changes pitch, corner/side handles set overhang, rotate handle on top. Show dimensions live.
- Overlapping roofs are allowed and render cleanly (no z-fighting: each roof gets a tiny height offset by creation order ≤ 2 mm).
- Roof parts: top surface, underside (soffit), fascia board, edge trim, ridge caps, optional gutters and downspouts (downspouts auto-placed at corners).
- Walls above a roof surface are cut to the roof underside when `wall.clipToRoof = true` (default for walls whose top would pierce a roof on the same level).
- Chimneys, dormers, cupolas, skylights, and solar panels are catalog objects with `placement: "roof"` that align to the roof plane. Dormers cut the roof (Patch B for full cut; v1 dormers sit on the surface with a masked underside).

### 9.4 Openings
- Catalog item defines `size [w, h]`, `cutProfile`, `defaultSill`, `allowedWallKinds`, `stackable`, `minWallHeight`.
- Placement: hover a wall side → preview snaps to half-tile centers along the wall, `Alt` for free placement, `,` and `.` nudge sill height by 0.1 m, `Alt+,`/`Alt+.` by 0.01 m.
- Auto-height: new windows default to aligning top edge with the tallest existing opening on that level, like a professional builder would.
- Doors and garage doors force `sill = 0` (relative to floor). Garage doors require full wall kind and ≥ 2.44 m clearance.
- Windows render with frame, mullions, glass (`MeshPhysicalMaterial`, transmission off for performance, env-mapped reflections), sill, optional shutters (separate item with `attachTo: "opening"`), optional awning, optional lintel/header.

### 9.5 Stairs and railings
- Stair types: straight, L with landing, U with landing, porch steps (wide, 1–4 risers), spiral (object-type, fixed footprint).
- Riser max 0.19 m, tread min 0.28 m; stair auto-computes risers from level height.
- Railings auto-apply to open platform/deck/balcony edges and stair sides (toggle), picked from railing items.

### 9.6 Terrain
- Heightmap at 2 samples per tile. Brushes: raise, lower, flatten (to sampled height), smooth, noise. Brush size 1–10 tiles, strength 0–1, falloff soft/hard.
- Terrain under a foundation auto-flattens to foundation base on commit (with a smooth skirt of 1 tile).
- Terrain paint: 4-layer splat per lot in v1 (layers chosen from terrain materials), brush + erase + fill.
- Paths and driveways: spline or tile-snapped, width 0.9–6 m, material, border option, follow terrain.

### 9.7 Pools and water
Pool tool drags like the room tool on a 1 m grid, depth 0.9–3 m, coping material, tile material, water shader (animated normal map, depth tint, fresnel). Shapes: rectangle, L, custom tile-union. Fountains are drag-built in the same system with a fountain edge item.

### 9.8 Fences
Drag like walls, snap to half tiles, post at each node, gates as openings in fences. Heights per item.

---

## 10. Materials, catalog registry, patches

### 10.1 Procedural material generators (`client/materials/`)
Each generator is a pure function: `generate(params, seed, size) → { albedo: Canvas, height: Canvas, roughness: Canvas }`. The material cache derives a normal map from `height` (Sobel), builds a `MeshStandardMaterial`, and caches it. All outputs must tile seamlessly (wrap-aware noise and pattern math).

Required generators v1:
| Generator | Pattern variants |
|---|---|
| `brick` | running bond, stack bond, flemish bond, english bond, herringbone, basketweave, whitewash/limewash overlay, painted, tumbled/used |
| `stone` | ashlar (cut), random rubble/fieldstone, stacked ledgestone, river rock, flagstone, coral stone, cobble |
| `stucco` | smooth, sand finish, dash, hand-troweled (Santa Fe), skip-trowel, adobe (rounded soft edges) |
| `siding_lap` | clapboard, dutch lap, beveled, log-lap |
| `siding_vertical` | board-and-batten, shiplap vertical, T1-11, reverse batten |
| `shingle` | cedar shake (wall), fishscale, diamond, staggered (Queen Anne mix) |
| `panel` | fiber cement panel with reveals, metal panel, HPL rainscreen |
| `wood` | cedar, redwood, teak, charred (shou sugi ban), weathered barnwood, tongue-and-groove soffit, log (round) |
| `metal` | corrugated, standing seam, copper (patina levels 0–3), zinc, corten |
| `concrete` | smooth, board-formed, exposed aggregate, split-face block, CMU |
| `roof_tile` | clay barrel (S/mission), spanish S, flat interlocking, slate, asphalt 3-tab, asphalt architectural, wood shake, thatch, standing seam metal, metal shingle, rubber membrane (flat), green roof |
| `paving` | pavers (rect, herringbone, basketweave), saltillo tile, flagstone, brick, cobble, concrete, stamped concrete, gravel, decomposed granite |
| `terrain` | grass (lush, dry, mixed), dirt, sand, gravel, mulch, moss, snow |
| `glass` | clear, low-E tint, frosted, stained (leaded pattern) |
| `plaster` | interior base only in v1 (for inner wall sides) |

Every material definition supports a `tint` (HSL shift applied on albedo) so the design tool can recolor any material.

### 10.2 Registry API
```js
KS.registry.registerPack({
  id: "core.exterior",            // unique pack id
  version: "1.0.0",               // semver
  requires: { "core.materials": ">=1.0.0" },
  materials: [ /* MaterialDef */ ],
  styles:    [ /* StyleDef */ ],
  items:     [ /* CatalogItem */ ]
});
```
- Duplicate IDs across packs: registry throws in dev, logs + skips in prod.
- `KS.boot()` validates every item against the schema and fails loudly in dev.

### 10.3 ID convention
`<domain>.<category>.<name>` lowercase snake_case.
- Materials: `mat.brick.chicago_common`, `mat.roof.clay_barrel`
- Items: `ext.window.double_hung_6over6`, `ext.door.front_craftsman_lite`, `ext.tree.live_oak_mature`
- Styles: `style.<family>.<name>` e.g. `style.midcentury.mcm`
- Interior (Patch A): `int.<category>.<name>`
IDs never change after release. Renames use `aliases: []`.

### 10.4 MaterialDef
```js
{
  id: "mat.stucco.hand_troweled",
  name: "Hand-troweled stucco",
  category: "stucco",                 // UI grouping
  surfaces: ["wall", "foundation"],   // where it can be applied: wall, foundation, roof, floor, terrain, trim, soffit
  generator: "stucco",
  params: { finish: "hand_troweled", depth: 0.6 },
  repeatMeters: [2, 2],
  roughness: 0.9, metalness: 0,
  swatches: [ { id: "cream", tint: "#EFE6D8" }, { id: "adobe", tint: "#C98E62" }, { id: "white", tint: "#F7F5F0" } ],
  styles: { "style.spanish.hacienda": 1.0, "style.spanish.santa_fe": 1.0, "style.european.tuscan": 0.7 },
  cost: { unit: "sqft", low: 7, high: 11, note: "3-coat stucco installed" },
  texture: null                        // optional jsDelivr URL to override generator
}
```

### 10.5 CatalogItem
```js
{
  id: "ext.window.casement_iron_tall",
  name: "Tall iron casement",
  category: "windows",                 // see 10.6
  subcategory: "casement",
  placement: "wall",                   // wall | ground | terrain | roof | opening | floor | ceiling | fence
  footprint: { w: 0.9, d: 0.15, h: 2.1 },
  opening: { cutProfile: "rect", defaultSill: 0.6, stackable: true, allowedWallKinds: ["full"] },
  build: (p, ctx) => THREE.Group,      // parametric geometry builder, see 10.7
  params: { panes: 2, muntins: "none", frameDepth: 0.08 },
  variants: [
    { id: "black",  materials: { frame: { id: "mat.metal.powder_coat", tint: "#1E1E1E" } } },
    { id: "bronze", materials: { frame: { id: "mat.metal.powder_coat", tint: "#4A3A2A" } } }
  ],
  styles: { "style.spanish.hacienda": 1.0, "style.contemporary.modern_farmhouse": 0.8, "style.european.french_country": 0.6 },
  cost: { unit: "each", low: 900, high: 1800, note: "installed, mid-grade" },
  tags: ["iron", "tall", "casement"],
  lod: { near: "full", far: "simplified" },
  thumbnail: "auto"                    // rendered at runtime and cached
}
```

### 10.6 Catalog categories (exterior v1) and content targets
| Category | Subcategories | v1 target count |
|---|---|---|
| Walls & siding (materials) | siding, masonry, stucco, panels, wood, metal | 120 materials × swatches |
| Foundations | slab, raised, pier, stem, skirt/lattice | 12 |
| Roofs (materials + trims) | tiles, shingles, metal, flat, trims, ridge caps, gutters | 60 |
| Roof decor | chimneys, dormers, cupolas, skylights, solar, weather vanes, finials | 40 |
| Windows | double-hung, casement, awning, picture, bay/bow, arched, round/oculus, clerestory, transom, storefront, dormer-fit, stained glass | 90 |
| Doors | front (single/double), sidelights/transoms, french, sliding, pivot, dutch, arched, barn, service | 60 |
| Garage doors | raised panel, carriage, modern glass, flush, roll-up, barn-style | 25 |
| Arches | round, pointed, segmental, square cased | 12 |
| Columns & posts | Doric, Ionic, Corinthian, Tuscan, tapered Craftsman, square, turned, steel, timber, stone pier | 35 |
| Trim & moulding | spandrels, friezes, cornices, dentils, corbels, brackets, quoins, window/door casings, shutters, awnings, gingerbread | 110 |
| Porches, decks, stairs, railings | deck boards, stair sets, railings (wood, iron, cable, glass, balustrade) | 45 |
| Fences & gates | picket, split-rail, privacy, horizontal slat, wrought iron, stone wall, stucco wall, ranch, hedge-fence | 40 |
| Landscaping | trees (by region), palms, shrubs, flowers, grasses, succulents/cacti, hedges, vines (wall-attached), planters, rocks | 160 |
| Hardscape & water | paths, driveways, pools, spas, fountains, ponds, retaining walls, fire pits, pergolas, gazebos, ramadas | 60 |
| Exterior lighting | sconces, lanterns, post lights, path lights, string lights, uplights | 45 |
| Exterior misc | mailboxes, house numbers, planters, trash enclosures, AC units, hose bibs, benches, outdoor kitchens (shell) | 40 |

Totals: ~950 items. Built family by family in Phase 5.

### 10.7 Geometry builder contract
- Signature: `build(params, ctx)`; `ctx` provides `ctx.mat(slotName)` (returns cached material for the active variant), `ctx.lib` (shared shape helpers: moulding profiles, lathe columns, panel doors, muntin grids, arch paths, extrude along path), `ctx.lod` (`"full"|"simplified"`).
- Returns a `THREE.Group` in item-local space: origin at footprint center at floor level; for wall items origin at wall centerline at sill height.
- No textures created inside builders. No per-instance materials. Geometry is cached by `(itemId, paramsHash, lod)` and reused for instancing.
- Triangle budgets: small decor ≤ 2k, windows/doors ≤ 6k, columns ≤ 4k, trees full ≤ 15k / simplified ≤ 3k / impostor 2 tris.
- Builders must produce correct normals and world-scale UVs.

### 10.8 Heavy assets (optional per item)
`model: { url: "https://cdn.jsdelivr.net/gh/<owner>/keystone-assets@v1.0.0/trees/live_oak.glb", scale: 1 }` loaded with `GLTFLoader` (+ Draco/meshopt decoders from the same repo). Used for organic items (trees, ornate ironwork) where procedural geometry falls short. Asset repo tags are immutable.

---

## 11. Style system

### 11.1 StyleDef
```js
{
  id: "style.spanish.hacienda",
  name: "Hacienda",
  family: "spanish_southwest",
  era: "1700s–present",
  summary: "Low, sprawling, courtyard-centered with thick stucco walls and clay tile roofs.",
  signature: {
    roofs: ["hip", "gable", "shed"], pitchDeg: [14, 22],
    roofMaterials: ["mat.roof.clay_barrel"],
    wallMaterials: ["mat.stucco.hand_troweled", "mat.stucco.adobe"],
    accentMaterials: ["mat.stone.fieldstone", "mat.wood.rough_beam"],
    windows: ["ext.window.casement_iron_tall", "ext.window.deep_set_arched"],
    doors: ["ext.door.front_plank_iron_straps", "ext.door.arched_double"],
    trim: ["ext.trim.vigas", "ext.trim.corbel_wood"],
    columns: ["ext.column.timber_post_corbel"],
    landscaping: ["ext.tree.live_oak_mature", "ext.plant.agave", "ext.plant.bougainvillea_vine"],
    features: ["courtyard", "covered_portal", "exposed_beams", "wrought_iron", "arched_openings"]
  },
  palette: {
    walls: ["#EFE6D8", "#E4D2B8", "#C98E62"],
    roof: ["#B5552F", "#9C4A2B"],
    trim: ["#4A3222", "#2B2B2B"],
    accent: ["#2F5D62", "#7A2E2A"]
  },
  shells: ["shell.hacienda.courtyard_u", "shell.hacienda.linear_portal"]
}
```

### 11.2 How styles are used
- **Catalog filter:** style chips filter every category. Items/materials with `styles[styleId] ≥ 0.5` show; sorted by weight.
- **Style match meter:** the build shows a live "style match" score for the selected primary style (weighted share of visible surface area and item count that matches).
- **Palette picker:** the design tool shows the style's palette first.
- **Starter shells:** one-click shells generate a complete, editable exterior (walls, foundation, roof, openings, trim, landscaping) via `ApplyStyleShell` as a single undo step. Shells are data (JSON layouts in `content/styles/shells/`), not code.
- Each style needs ≥ 2 shells by end of Phase 5 (≥ 2 per style).

### 11.3 Full style list (v1)
Signature notes are the minimum each StyleDef must capture.

**American Colonial & Early** (`colonial`)

| ID | Style | Signature |
|---|---|---|
| `georgian` | Georgian | Symmetrical box, side-gable or hip, 5-bay facade, paneled door with transom/pediment, 9-over-9 windows, brick, dentil cornice |
| `federal` | Federal/Adam | Georgian but lighter; fanlight over door, elliptical details, slender sidelights, low-pitch roof with balustrade |
| `dutch_colonial` | Dutch Colonial | Gambrel roof with flared eaves, shed dormers, stone or shingle walls |
| `french_colonial` | French Colonial | Raised main floor, wide hipped roof over wraparound galerie, thin posts, French doors |
| `spanish_colonial` | Spanish Colonial | Thick adobe/stucco, low-pitch or flat roof, small deep windows, wooden grilles, courtyard |
| `cape_cod` | Cape Cod | 1–1.5 story, steep side gable, central chimney, cedar shingles, symmetrical, dormers |
| `saltbox` | Saltbox | Asymmetric gable long in back, central chimney, clapboard |
| `greek_revival` | Greek Revival | Front-gable temple form, full-height columns, wide frieze, pediment, white |
| `southern_colonial` | Southern Colonial/Plantation | Two-story, full-width double porch, tall columns, hip roof, symmetrical |

**Victorian Era** (`victorian`)

| ID | Style | Signature |
|---|---|---|
| `queen_anne` | Queen Anne | Asymmetric, turret, wraparound porch, mixed shingle patterns, spindlework, bay windows, steep complex roof |
| `italianate` | Italianate | Low hip roof, wide eaves with paired brackets, tall arched windows with hoods, cupola |
| `second_empire` | Second Empire | Mansard roof with dormers, brackets, iron cresting |
| `gothic_revival` | Gothic Revival | Steep cross gables, pointed-arch windows, decorative bargeboard, board-and-batten |
| `stick` | Stick | Exposed decorative stickwork on siding, steep gables, trusses in gables |
| `shingle` | Shingle Style | Continuous shingle skin, broad gables, eyebrow dormers, stone base, porches |
| `folk_victorian` | Folk Victorian | Simple farmhouse form with spindlework porch and brackets |

**Early 20th Century American** (`early20`)

| ID | Style | Signature |
|---|---|---|
| `craftsman` | Craftsman | Low gable, exposed rafter tails, tapered columns on piers, knee braces, mixed siding and stone |
| `bungalow` | Bungalow | 1–1.5 story, deep front porch, broad gable/dormer, simple massing |
| `prairie` | Prairie | Horizontal lines, low hip roof, very deep eaves, ribbon windows, brick/stucco bands |
| `tudor_revival` | Tudor Revival | Steep front gables, half-timbering, tall chimneys, casement windows with diamond panes, brick/stone |
| `colonial_revival` | Colonial Revival | Georgian/Federal cues simplified, accentuated front door, symmetrical |
| `foursquare` | American Foursquare | Cubic 2-story, hip roof, central dormer, full-width porch |

**Spanish & Southwest** (`spanish_southwest`)

| ID | Style | Signature |
|---|---|---|
| `hacienda` | Hacienda | See 11.1 |
| `spanish_revival` | Spanish Colonial Revival | Red tile, white stucco, arches, wrought iron, towers, decorative tile |
| `mission_revival` | Mission Revival | Curvilinear parapets, arcades, quatrefoil window, red tile |
| `pueblo_revival` | Pueblo Revival | Flat roof, rounded parapets, vigas, stepped massing, earth tones |
| `territorial` | Territorial | Pueblo massing with brick coping, square columns, pedimented window heads |
| `santa_fe` | Santa Fe | Pueblo/Territorial mix, hand-troweled stucco, portal, kiva chimney |
| `texas_hill_country` | Texas Hill Country | Limestone walls, standing-seam metal roof, deep porches, steel/cedar accents |

**Mid-Century & Postwar** (`midcentury`)

| ID | Style | Signature |
|---|---|---|
| `mcm` | Mid-Century Modern | Low flat/butterfly/shed roofs, clerestories, floor-to-ceiling glass, post-and-beam, breeze block, carport |
| `ranch` | Ranch | Single story, long low hip/gable, attached garage, picture window |
| `california_ranch` | California Ranch | Rambling L/U plan, board-and-batten, courtyards, sliders |
| `split_level` | Split-Level | Staggered half-levels, mixed siding, attached garage |
| `a_frame` | A-Frame | Steep triangular roof to ground, glass gable end |
| `desert_modern` | Desert Modern | Palm Springs flat planes, stone walls, breeze block, deep overhangs, pool-oriented |
| `googie` | Googie | Upswept roofs, boomerang shapes, bold signage-like forms |

**Farm & Rural** (`rural`)

| ID | Style | Signature |
|---|---|---|
| `farmhouse` | Traditional Farmhouse | Gable roof, wraparound porch, clapboard, double-hung windows |
| `modern_farmhouse` | Modern Farmhouse | White board-and-batten, black windows, metal roof accents, gable forms |
| `barndominium` | Barndominium | Metal building form, wide gable, wainscot, large porch |
| `log_cabin` | Log Cabin | Round/hewn logs, stone chimney, gable, porch |
| `adirondack` | Adirondack / Rustic Lodge | Bark-on logs, twig work, stone base, steep roofs |
| `mountain_modern` | Mountain Modern | Timber + stone + glass, shed/gable, big overhangs, metal roof |

**Coastal & Regional** (`coastal`)

| ID | Style | Signature |
|---|---|---|
| `coastal` | Coastal / Beach | Light siding, big porches, shutters, metal or shingle roof |
| `raised_beach` | Raised Beach House | Pilings, stairs, wraparound decks, hip roof |
| `lowcountry` | Lowcountry | Raised foundation, deep porches, metal roof, dormers, tall windows |
| `florida_cracker` | Florida Cracker | Raised, metal roof, dogtrot/breezeway, wide porches |
| `pnw` | Pacific Northwest | Cedar, stone, low gables, big glass, deep eaves |
| `creole_cottage` | Creole Cottage | Side-gable at sidewalk, full-width front, paired French doors, shutters |
| `shotgun` | Shotgun | Narrow, front gable, deep lot, brackets on front porch |

**European** (`european`)

| ID | Style | Signature |
|---|---|---|
| `french_country` | French Country | Steep hip, stone/stucco, arched windows, shutters, dormers |
| `chateauesque` | Châteauesque | Steep roofs, turrets, spires, stone, elaborate dormers |
| `tuscan` | Tuscan | Stone/stucco, clay tile low hip, arches, loggia, cypress |
| `mediterranean` | Mediterranean | Stucco, tile roof, arches, balconies with iron |
| `cycladic` | Cycladic (Greek Island) | White cubic masses, flat roofs, blue accents, domes |
| `english_cottage` | English Cottage | Steep roof (thatch option), stone/brick, chimney, small-paned windows, garden |
| `regency` | Regency | Stucco, symmetrical, bow fronts, iron balconies, low roof |
| `swiss_chalet` | Swiss Chalet | Front gable with very wide eaves, carved balconies, wood upper over stone base |
| `alpine` | Alpine | Heavy timber, stone base, steep gable, snow guards |
| `scandinavian` | Scandinavian | Simple gable, black or falu-red wood, minimal trim, large windows |

**Classical & Historic** (`classical`)

| ID | Style | Signature |
|---|---|---|
| `neoclassical` | Neoclassical | Monumental portico, full-height columns, symmetrical, pediment |
| `beaux_arts` | Beaux-Arts | Grand symmetrical stone, rusticated base, ornate cornice, paired columns |
| `italian_renaissance` | Italian Renaissance | Low hip tile roof, arched first floor, smaller upper windows, brackets |
| `gothic` | Gothic (Historic) | Pointed arches, tracery, buttresses, steep roofs, stone |
| `romanesque` | Richardsonian Romanesque | Heavy rusticated stone, round arches, towers |

**Modernist Movements** (`modernist`)

| ID | Style | Signature |
|---|---|---|
| `bauhaus` | Bauhaus | Flat roof, white cubic volumes, ribbon windows, no ornament |
| `international` | International Style | Pilotis, glass curtain walls, flat roof, free facade |
| `art_deco` | Art Deco | Vertical emphasis, stepped parapets, geometric ornament, stucco |
| `streamline_moderne` | Streamline Moderne | Rounded corners, horizontal bands, glass block, porthole windows |
| `art_nouveau` | Art Nouveau | Organic curves, whiplash ironwork, floral motifs |
| `brutalist` | Brutalist | Board-formed concrete, massive geometric forms, deep openings |
| `organic` | Organic | Horizontal, natural stone/wood, cantilevers, integrated with site |
| `postmodern` | Postmodern | Oversized classical cues, bold color, playful forms |

**Contemporary** (`contemporary`)

| ID | Style | Signature |
|---|---|---|
| `contemporary` | Contemporary | Mixed materials, large glass, asymmetric flat/shed roofs |
| `minimalist` | Minimalist | Pure volumes, hidden gutters, frameless glass, monochrome |
| `industrial` | Industrial | Steel, brick, corrugated metal, factory windows |
| `shipping_container` | Shipping Container | Corrugated container modules, stacked/cantilevered |
| `tiny_house` | Tiny House | Small footprint, gable/shed, loft dormers, trailer-base option |
| `passive_eco` | Passive / Eco | Compact form, deep overhangs, solar, green roof, triple glazing |
| `parametric` | Parametric / Futurist | Curved/faceted skins, ribbed panels (limited in v1; full in Patch B) |
| `deconstructivist` | Deconstructivist | Angled volumes, fragmented planes (limited in v1) |

**Global** (`global`)

| ID | Style | Signature |
|---|---|---|
| `minka` | Japanese Traditional (Minka) | Heavy timber, deep eaves, engawa veranda, shoji-style screens, tiled or thatched roof |
| `japandi` | Japandi | Japanese + Scandinavian: light wood, low lines, minimal |
| `balinese` | Balinese / Tropical | Steep thatch or tile, open pavilions, timber, stone, water features |
| `moroccan` | Moroccan | Horseshoe arches, zellige tile accents, flat roofs, courtyards |
| `middle_eastern_courtyard` | Middle Eastern Courtyard | Inward courtyard, thick walls, mashrabiya screens, wind towers |
| `chinese_courtyard` | Chinese Courtyard (Siheyuan) | Enclosed courtyard, upturned tile eaves, red columns, gray brick |

Total: 86 styles. IDs are `style.<family>.<id>`.

---

## 12. Tools

All tools implement `{ id, enter(), exit(), onPointerMove, onPointerDown, onPointerUp, onKey, preview }`. Previews are drawn in a separate scene layer, never in state. Invalid placements show red with a reason tooltip ("Needs a full-height wall").

| Tool | Key | Behavior |
|---|---|---|
| Select / move | `V` | Click to select, drag to move, `Shift` multi-select, box-select by dragging empty space, `Del` deletes, `M` move, `,`/`.` rotate 45° |
| Wall | `1` | Click-drag to draw; drag through existing walls splits them; `Ctrl`+drag deletes walls along the drag path; `Shift` locks to 45° increments (default) vs free with `Alt`; live length label |
| Room | `2` | Drag rectangle to create 4 walls + room; hover a room wall to show push/pull arrow, drag to move that wall (and attached perpendiculars); hover room center to show move/rotate handle; `Ctrl`+drag rectangle deletes enclosed walls |
| Foundation | `3` | Toggle foundation for level 0, scroll wheel or handle to set height, choose type and material |
| Platform | `4` | Drag rectangle, set height, material |
| Floor tile | `5` | Paint exterior floor tiles: click tile, `Shift` flood-fill region, `Ctrl` erase, `Alt` quarter-tile mode |
| Roof | `6` | Pick type; drag rectangle; edit via handles; "Auto-roof" button builds from active level footprint |
| Paint (wall/roof/foundation) | `P` | Click a surface to apply the active material + tint; `Shift` applies to all exterior sides of that room / whole level; `Ctrl` applies to every connected wall of the same current material |
| Eyedropper | `I` | Click anything: copies material+tint (surfaces) or item+variant+params (objects) into the active tool |
| Design (recolor) | `U` | Click object or surface, pick swatch or custom color (HSL wheel), per material slot |
| Opening placement | from catalog | Hover wall, snap, adjust sill, click to place; `Shift` keeps tool active for repeats |
| Object placement | from catalog | Hover surface, grid snap, rotate with `,`/`.` or right-drag, `Alt` free, click to place |
| Fence | `8` | Drag like wall, gates placed as openings |
| Stairs | `7` | Pick type, click start, drag direction, auto-length |
| Path / driveway | `0` | Click points along a spline, double-click to finish, width handle |
| Pool | `9` | Drag like room, depth slider, coping/tile materials |
| Terrain sculpt | `T` | Raise/lower/flatten/smooth/noise, `[`/`]` brush size, `Shift` inverts |
| Terrain paint | `G` | Paint layer, `[`/`]` size, `Ctrl` erase |
| Sledgehammer | `K` | Click to delete anything, hover highlights; `Shift` deletes all of the same item on the lot (confirm dialog) |
| Trim | `Y` | Apply spandrel / frieze / foundation trim to a whole level |

Global keys: `Ctrl+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo, `Ctrl+S` save (default browser action suppressed), `Ctrl+C`/`Ctrl+V` copy/paste selection, `Page Up`/`Page Down` level up/down, `Home` cycle wall mode (up/cutaway/down), `R` toggle roofs, `Tab` toggle camera mode, `Esc` cancel preview and return to Select, `?` shortcuts overlay, `F9` screenshot.

Reserved for camera, never bound to tools: `W A S D Q E Z X C Space`. Never bind browser-owned keys (`Ctrl+R`, `Ctrl+W`, `Ctrl+T`, `F1`, `F5`, `F11`, `F12`).

### 12.1 Camera
- **Build camera (default):** orbits a ground target. Right-drag orbits, middle-drag pans, scroll zooms toward the cursor. `WASD` pans the target, `Q`/`E` rotate, `Z`/`X` zoom, arrow keys also pan. Pitch clamped 10°–85°. Smooth damping (critically damped spring, ~120 ms).
- **Free camera (`Tab`):** fly camera, `WASD` + mouse look, `Space` up, `C` down, for screenshots and walk-arounds.
- Zoom range 3 m – 150 m. Target stays within lot bounds + 10 m.
- Double-click an object or wall to focus the camera on it.
- Camera keys are ignored while a text input has focus.

---

## 13. UI and visual identity

### 13.1 Identity tokens
| Token | Value | Use |
|---|---|---|
| `--survey` | `#0F7C8C` | Primary actions, active tool, selection outline |
| `--brass` | `#C39A3E` | Handles, drag affordances, style match meter |
| `--graphite` | `#27303A` | Text, icon strokes |
| `--mortar` | `#EEF1F0` | Panel base (at 92% opacity with 16 px backdrop blur over the 3D view) |
| `--limewash` | `#FFFFFF` | Cards, inputs |
| `--brick` | `#B4432F` | Errors, destructive actions, invalid placement |
| `--sage` | `#5E8B6A` | Success, "within budget" |

- Type: Manrope 400/600/700. Sentence case everywhere, no all-caps labels. Costs use `font-variant-numeric: tabular-nums`.
- Radius: 14 px for floating panels, 8 px for tiles, 999 px for chips only. Different radii by hierarchy on purpose.
- Icons: custom inline SVG set, 1.75 px stroke, drawn in-house (no third-party game icons).
- The one bold element: the catalog's category bar is a row of small house-silhouette icons, each showing the part of a house it controls highlighted (roof, walls, windows, doors, yard). Everything else stays quiet.
- Motion: panels slide 160 ms on open; placement "settles" with a 90 ms scale ease. `prefers-reduced-motion` disables both.

### 13.2 Layout
```
┌────────────────────────────────────────────────────────────────────┐
│ [≡ Builds] Build name ✎      Level ▲▼ 1   Walls: Up▾  ☀ 4:30pm ▶  ⚙│  top bar
│                                                                    │
│ ┌─┐                                                   ┌──────────┐ │
│ │W│  tool rail                                        │ Cost     │ │
│ │R│                                                   │ $412,300 │ │
│ │O│                  3D VIEW                          │ Style    │ │
│ │B│                                                   │ ███░ 78% │ │
│ │…│                                                   └──────────┘ │
│ └─┘                                                                │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ [house icons: Roof Walls Windows Doors Trim Porch Yard Water ⋯]│ │
│ │ Style: [All] [Hacienda ✓] [Santa Fe] [+]   🔍 search   Sort ▾   │ │
│ │ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢  (thumbnail grid, swatches)   │ │
│ └────────────────────────────────────────────────────────────────┘ │  catalog (collapsible)
└────────────────────────────────────────────────────────────────────┘
```
- Catalog tile: thumbnail, swatch dots, cost on hover, style weight pips on hover, favorite star.
- Hover card: name, size, cost range, styles, "Place" / "Eyedrop" actions.
- Right-click context menu on anything: Move, Rotate, Recolor, Copy, Delete, Select all of this.
- History panel (from top bar ⋯): undo list with labels, click to jump.
- Builds screen: gallery grid of thumbnails, name, updated date, style, estimated cost; New build (blank / from shell), Duplicate, Rename, Delete (with confirm), Export, Import.
- New-build wizard: lot size → primary style → start blank or pick a shell.
- Settings: units, graphics preset, autosave interval, cost region multiplier, key reference.
- Empty states give an action ("No builds yet. Start a new build.").
- Errors state what happened and how to fix it ("Save failed: Drive quota reached. Delete old builds or free up Drive space.").

### 13.3 Thumbnails
Rendered at runtime by an offscreen renderer (256×256, 3/4 view, studio light), cached in IndexedDB keyed by `itemId|variant|packVersion` (memory fallback). Generated lazily in idle time, visible tiles first.

### 13.4 Accessibility and input
Keyboard reachable panels, visible focus rings, tooltips on every icon, minimum 32 px hit targets. Tablet: view-only mode with orbit/zoom touch gestures in v1.

---

## 14. Server API and persistence

### 14.1 Google resources
- Sheet **Keystone Index**
  - `Builds`: `buildId | name | owner | primaryStyle | levels | estCostLow | estCostHigh | created | updated | driveFileId | thumbFileId | schema | deleted`
  - `Users`: `email | role (owner/editor/viewer) | addedOn`
  - `Settings`: `key | value` — `builds_folder_id`, `github_repo` (owner/keystone), `asset_base_url`, `stable_tag`, `default_units`, `region_multiplier`
  - `Log`: `timestamp | email | action | buildId | detail`
- Drive folder **Keystone Builds** (ID stored in Settings).

### 14.2 Server functions (`google.script.run`, wrapped client-side in promises)
| Function | Returns |
|---|---|
| `api_whoami()` | `{ email, role }` or access denied |
| `api_listBuilds()` | Array of index rows (non-deleted) |
| `api_beginSave(buildId, meta)` | `{ uploadId }` |
| `api_saveChunk(uploadId, index, base64)` | `{ ok }` (chunks stored in `CacheService`, 6 h TTL) |
| `api_commitSave(uploadId, totalChunks, thumbBase64)` | `{ buildId, updated, driveFileId }` — assembles, writes Drive file, updates index row, uses `LockService` |
| `api_loadBuildInfo(buildId)` | `{ meta, totalChunks }` |
| `api_loadChunk(buildId, index)` | base64 chunk |
| `api_deleteBuild(buildId)` | soft delete (sets `deleted`, moves file to a `Trash` subfolder) |
| `api_duplicateBuild(buildId, newName)` | new row |
| `api_getThumb(buildId)` | base64 JPEG |
| `api_getSettings()` / `api_setSetting(k, v)` | settings (owner only for set) |

- Every function: auth check → try/catch → `Log` row on writes → structured error `{ code, message }`.
- CacheService values have a per-key size cap, so if a chunk is rejected, the client halves chunk size and retries (down to 100 KB).
- Conflict rule: `api_commitSave` compares client's `baseUpdated` with the index row. If newer on server, it saves as `<name> (conflict copy)` and tells the user.

### 14.3 Client persistence
- Autosave every 60 s when dirty (setting 30–300 s) and on `visibilitychange` hidden. Autosave writes a local recovery copy to IndexedDB first, then Drive.
- On load, if a local recovery copy is newer than the Drive version, prompt: "Recover unsaved changes from 4:12 PM?"
- Export: download `.ksb` (gzip JSON). Import: file picker → validate → migrate → new build.
- Screenshots: `F9` renders at 2× current size with UI hidden, saved to Drive `Keystone Builds/Screenshots` and offered as download.

---

## 15. Cost estimator

- Live panel shows **low – high** total and a breakdown: foundation, framing/shell, exterior finish, roofing, windows, doors, trim, porches/decks, hardscape, landscaping, pools, lighting.
- Quantities:
  - Foundation: footprint area (sqft) × foundation material rate by type.
  - Shell framing: exterior wall area × framing rate + conditioned floor area × structure rate (setting-driven).
  - Exterior finish: exterior-facing wall side area minus openings, by material.
  - Roofing: true sloped roof area by material + trim linear ft + gutters linear ft.
  - Items: per-each cost × count.
  - Paving/terrain: area × rate.
- `regionCostMultiplier` (Settings, default 1.00) scales everything.
- Starter rate table lives in `content/materials/costs.js` and is editable data. Seed values (national installed ballparks, USD, to be reviewed by the owner before release):

| Item | Unit | Low | High |
|---|---|---|---|
| Vinyl siding | sqft | 4 | 8 |
| Fiber cement siding | sqft | 6 | 13 |
| Wood lap siding | sqft | 7 | 15 |
| Stucco (3-coat) | sqft | 7 | 11 |
| Brick veneer | sqft | 12 | 25 |
| Natural stone veneer | sqft | 20 | 45 |
| Asphalt architectural shingle | sqft roof | 4.5 | 8 |
| Standing seam metal | sqft roof | 10 | 18 |
| Clay tile | sqft roof | 15 | 30 |
| Slate | sqft roof | 20 | 40 |
| Concrete slab foundation | sqft | 6 | 12 |
| Pier-and-beam foundation | sqft | 9 | 16 |
| Wood/composite deck | sqft | 25 | 60 |
| Paver patio | sqft | 15 | 35 |
| Concrete driveway | sqft | 7 | 14 |
| In-ground pool (shell + finish) | each | 55,000 | 120,000 |

- UI labels the number as an estimate, and the breakdown is exportable to CSV (`api_exportCost` writes a new tab in the index Sheet named after the build).

---

## 16. Phases and definition of done

Each phase ends with a tagged release (`v0.<phase>.0`), a deployed test URL, and the Architect's review sign-off in `docs/reviews/phase-N.md`.

| Phase | Scope | Done when |
|---|---|---|
| **0. Foundation** | Repo scaffold, esbuild pipeline, GitHub Actions CI + release, loader `Index.html`, server auth, Sheet menu + updater, all six Phase 0 gates (§2.1), `docs/SETUP.md` | Test URL shows lit cube with shadows from a `build-*` tag; merging a PR updates the test URL with no manual steps; gates recorded |
| **1. Core engine** | Store, commands, events, lot, terrain mesh (flat), grid, build camera, sky + sun, graphics presets, picking, save/load/autosave/recovery, builds screen | Create a build, orbit it, save, reload the browser, load it back identical; undo/redo works for a dummy command |
| **2. Structure** | Wall graph (split/merge), wall mesh with miters, room detection, room tool with push/pull/move/rotate, foundations, platforms, levels, floor tiles, wall modes, level visibility, paint tool with 10 starter materials | Build an L-shaped two-story shell on a raised foundation, paint it, undo everything step by step; vitest suite covers split/merge/room detection with ≥ 40 cases |
| **3. Hard systems** | Roofs (all v1 types, rect + auto-roof, handles, gable infill, clip walls, gutters), openings (cut profiles, reveals, auto-height, doors, garage doors), stairs, railings | Auto-roof correctly covers L, T, U, and courtyard footprints; 20 window/door test items place, move, and cut cleanly on every wall case including split walls |
| **4. Look and workflow** | Full procedural material library (§10.1), material cache, design/recolor tool, eyedropper, sledgehammer, select/move/copy/paste, catalog UI, style filter, thumbnails, history panel, cost panel, style match meter, visual identity pass | A new user can build and finish a simple house using only the UI and the shortcut overlay; 60 fps target met on the reference scene |
| **5. Content** | All 12 style families: materials, items, style defs, ≥ 2 shells per style; landscaping; fences; paths; pools; lighting; terrain sculpt + paint | Content targets in §10.6 met; every style's shells load, look correct, and score ≥ 85% on their own style match meter |
| **6. Polish** | SSAO, time-of-day animation, night lighting (exterior fixtures emit), screenshots, performance tuning, LODs, impostors, error/empty states, onboarding tips | Reference scene (40×40, 2 levels, 3,000 objects) holds 60 fps High on the reference laptop; zero console errors in a 30-minute session |
| **7. Interior patch** | `catalog-interior.js` (from `src/content/interior`), interior materials, wallpaper/flooring tools, ceilings, interior lights, furniture placement rules | Existing v1 saves open unchanged; interior pack loads with no engine edits beyond registering new tool panels |

---

## 17. Two-AI workflow

### 17.1 Roles
- **Architect:** Claude Opus 5 in a claude.ai Project named *Keystone*, with this spec as project knowledge. Owns the spec, writes tickets, designs hard algorithms (room detection, straight skeleton roofs, wall/opening meshing, cutaway), reviews every PR against the spec, approves phase completion.
- **Builder:** Claude Code **cloud sessions** (Claude desktop app → Code tab, or claude.ai/code) on the `keystone` repo. Default model Sonnet 5 for volume work. Switch with `/model opus` for tickets tagged `hard`.
- **Owner:** approves tickets, merges PRs on github.com, tests the test URL, promotes stable tags. Nothing to install.

### 17.2 Loop
1. Architect writes the ticket. Owner saves it to `docs/tickets/NNN-short-name.md` on github.com (Add file → Create new file) or asks the Builder to commit it verbatim.
2. Owner starts a cloud session on `keystone`: "Do ticket NNN."
3. Builder implements on a branch, runs `npm test` and `npm run build` inside the session, updates `CHANGELOG.md`, fills in the ticket's Handoff section, and opens a PR.
4. CI runs on the PR. Owner turns on Auto-fix for the PR so CI failures get fixed automatically.
5. Owner pastes the PR link and the Handoff section into the Architect Project. Architect reviews (it can read the public PR diff) and either approves or posts exact change requests, which the owner leaves as PR review comments for Auto-fix to pick up.
6. Owner merges. Release Action publishes `build-N` to the test URL.
7. At phase end, owner promotes the tag to stable.

### 17.3 Ticket template
```md
# NNN — Title
Phase: 2 · Tag: hard | normal · Spec sections: §6.1, §9.1
## Goal
One paragraph on the outcome.
## Requirements
- Concrete, testable requirements.
## Out of scope
- Explicit exclusions.
## Acceptance
- [ ] Checks the owner can verify in the deployed app.
- [ ] Tests that must exist and pass.
## Handoff (Builder fills in)
```

### 17.4 Guardrails
- Builder never edits `docs/SPEC.md`. If the spec is wrong or silent, stop and write the question in the ticket's handoff section.
- One ticket per change set. No drive-by refactors.
- Architect keeps a running `docs/decisions/` log for any locked-decision change.

---

## 18. Testing

- **Unit (vitest):** wall split/merge, room detection, straight skeleton, opening fit checks, stair math, command undo symmetry (every command: do→undo returns deep-equal state), serializer round-trip, migrations, cost math.
- **Geometry fixtures:** `tests/fixtures/*.json` builds (L, T, U, courtyard, diagonal, overlapping roofs, 4-level stack) loaded by tests and by a dev "fixture browser" screen.
- **Visual check:** dev-only route `?dev=gallery` renders every catalog item in a grid with its variants for eyeball review each phase.
- **Performance:** dev overlay (`?dev=stats`) shows fps, draw calls, triangles, textures, memory. Reference scene lives in fixtures.
- **Manual QA checklist** per phase in `docs/qa/phase-N.md`.

---

## 19. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| HtmlService blocks external scripts or jsDelivr is slow | Blocks load | Phase 0 loader gate; server-side fetch + cache fallback |
| Public repo exposes source | Competitors can read code | Accept for build phase; §2.3 private path when commercializing |
| Cloud session network rules block a needed domain | Builder can't install packages or test | Default Trusted network covers npm and GitHub; adjust environment network access if needed |
| Straight skeleton roofs are hard to get right | Ugly roofs, delays | Architect designs algorithm first, fixture-driven tests, rect-mode roofs ship first so building is never blocked |
| Procedural textures look flat | "Not beautiful" | Height→normal maps, roughness variation, macro color noise, per-material tuning pass in Phase 6; jsDelivr texture override per material |
| Two AIs drift apart | Rework | Spec is law, ticket-based work, Architect review on every change |
| Drive save conflicts across family members | Lost work | Conflict copies, recovery copies, soft delete |
| Content volume (~950 items) | Time | Parametric builders + shared `ctx.lib`; families built in order of owner priority |
| Performance with dense landscaping | Low fps | Instancing, LODs, impostors, render on demand |
| Consumer account auth quirks | Access failures | Execute as user accessing + allowlist; tested in Phase 0 |

---

## 20. Glossary
- **Spandrel:** trim band between levels on the exterior.
- **Frieze:** trim band at the top of the top level under the roof.
- **Reveal / jamb:** the inner faces of an opening through the wall thickness.
- **Straight skeleton:** algorithm that shrinks a polygon inward to find hip and valley lines for roofs.
- **Shell:** a pre-built, editable exterior layout for a style.
- **Pack:** a catalog bundle registered at boot (core or patch).
- **Impostor:** a flat camera-facing image replacing a distant 3D object.
