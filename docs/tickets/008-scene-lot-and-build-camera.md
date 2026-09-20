# 008 — Scene, lot, and build camera
Phase: 1 · Tag: normal · Spec sections: §4.1, §4.2, §5, §8.1, §8.2, §8.3, §12.1, §16, §18 · Follows: 007

## Goal

Turn the store into something you can look at. This ticket builds the renderer, the sky and sun, the graphics presets, the flat terrain mesh, the build grid, the scene-sync layer, and the build camera. `KS.boot` stops mounting the Phase 0 cube and starts mounting a real lot built from a real Build document.

After this, opening the test URL shows an empty lot under a sky at 4:30 pm that you can orbit, pan, and zoom, with the sun moving when `timeOfDay` changes. Nothing is placed, nothing is picked, nothing is saved.

This is also where **render on demand** lands. Ticket 001 deferred it to "the real engine in Phase 1" and this is that ticket; the `docs/DEFERRED.md` entry comes out as part of the work.

## Requirements

### 1. `src/client/engine/renderer.js`

Lift the §8.1 setup out of `dev/boot-cube.js` and generalize it:

- `WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, exposure 1.0 and auto-adjusted with time of day (§8.2).
- `shadowMap.type = PCFSoftShadowMap`. Directional sun casting shadows, hemisphere light for sky/ground bounce, subtle ambient at night for readability.
- Shadow camera frustum fits the lot bounds (§4.2), recomputed when the lot size changes, not every frame.
- Resize handling, context-loss handling that re-creates the renderer rather than leaving a dead canvas.

**Render on demand (§4.2).** A `requestRender()` call schedules exactly one frame on the next animation frame; repeated calls within the same frame coalesce. Frames are scheduled only when the camera moves, the store emits a `change`, the time-of-day animation is running, or the canvas resizes. There is no unconditional loop. A `renderCount` counter is exposed for tests.

**Adaptive pixel ratio.** `setPixelRatio(Math.min(devicePixelRatio, 2))`, lowered a step when frame time exceeds 20 ms for 2 continuous seconds, per §4.2. It never raises itself back automatically within a session; a preset change resets it.

### 2. `src/client/engine/sky.js`

- Custom shader dome: vertical gradient, sun disc, horizon haze. Night is a deep blue gradient with stars as points.
- `computeSunPosition({ timeOfDay, latitude, season, orientationDeg })` per §8.2 — a solstice/equinox approximation is explicitly acceptable. It is a pure function and must be exported separately from anything touching Three.js so it can be tested directly.
- The sun direction, sky colors, and exposure all derive from that one function. Driving the sky is the only consumer of `lot.environment`.
- A `?dev=sun` route scrubs `timeOfDay` from 0 to 24 through the `SetEnvironment` command from ticket 007, so the sky can be checked without any UI. This is how the environment path gets exercised before the top bar exists.

### 3. `src/client/engine/presets.js`

The §8.3 table, exactly:

| Preset | Shadows | Post | Pixel ratio cap | Texture size |
|---|---|---|---|---|
| Low | off | off | 1 | 512 |
| Medium | 1024 | off | 1.5 | 1024 |
| High | 2048 | SSAO | 2 | 1024 (2048 hero) |

SSAO itself is Phase 6; on High the post slot is present and switched off, and the preset records that it wants it. Do not ship a stub post pass. Switching presets disposes the GPU resources the old preset allocated.

### 4. `src/client/geometry/terrain.js`

- Build the terrain mesh from `lot.terrain.heights` at `resolution` 2 samples per tile, per §5 and §6. Flat heights only — nothing sculpts yet.
- Y up, 1 tile = 1.0 m, lot origin at the southwest corner (§5).
- The surrounding low-detail ground ring with neutral grass and fog to the horizon (§8.1).
- The splat/paint layers exist in the document but are not rendered in this ticket; the terrain gets one flat material.
- Rebuilding on a lot-size change must dispose the previous geometry and material.

### 5. `src/client/engine/grid.js`

The build grid: full-tile lines at 1 m over the lot footprint, half-tile lines shown at closer zooms, origin corner marked. Visual only — snapping belongs to the tools that arrive later. The grid dims rather than disappears when the camera pitches low, so the ground plane stays readable.

### 6. `src/client/engine/sync.js`

The §4.1 scene-sync layer.

- Subscribes to the store's `change` event and rebuilds only what the dirty categories name.
- Holds a registry: `registerBuilder(category, fn)`. Categories with no registered builder are ignored silently — that is what lets later tickets add walls, roofs, and objects without editing this file.
- In this ticket only `terrain`, `levels` (lot size), `environment`, and `camera` have builders.
- Every rebuild ends with `requestRender()`. Nothing else in the codebase may call `requestRender` on a store change; the single path keeps render-on-demand honest.
- Disposal is the builder's responsibility and the registry contract says so: a builder replacing a mesh disposes the one it replaces.

### 7. `src/client/engine/camera.js`

Build camera per §12.1:

- Orbits a ground target. Right-drag orbits, middle-drag pans, scroll zooms toward the cursor.
- `WASD` pans the target, `Q`/`E` rotate, `Z`/`X` zoom, arrow keys pan.
- Pitch clamped 10°–85°. Zoom range 3 m – 150 m. Target clamped to lot bounds + 10 m.
- Critically damped spring smoothing, roughly 120 ms. The spring is what drives `requestRender` while it settles, and it must stop scheduling frames once it is within epsilon of rest — a spring that never quite arrives is an infinite render loop wearing a disguise.
- Free camera on `Tab` (§12.1): fly camera, `WASD` plus mouse look, `Space` up, `C` down.
- Camera keys are ignored while a text input has focus.
- `W A S D Q E Z X C Space` are reserved for the camera and must not be bound to anything else (§12). Browser-owned keys are never bound.
- Double-click-to-focus is **not** in this ticket; it needs picking.

### 8. Boot and cleanup

- `KS.boot` creates a default in-memory Build document via ticket 007's `createBuildDocument`, builds the scene from it, and mounts it under `#ks-root`. No server calls, no persistence.
- Delete `src/client/dev/boot-cube.js`. Ticket 001 said this ticket would remove it.
- The `?dev=gates` gate 1 probe now measures first render of the lot scene rather than the cube. Note the change in `docs/PHASE0_RESULTS.md` next to the original 109 ms figure rather than overwriting it — the historical number was measured against different content and should not silently become a comparison it is not.
- Remove the render-on-demand entry from `docs/DEFERRED.md`. Leave the `registerPack` validation entry.

## Out of scope

- Picking, selection, hover, double-click focus.
- Every tool. Nothing places, draws, or edits.
- Walls, rooms, roofs, floors, objects, openings.
- Terrain sculpting and painting. The splat data rides along unrendered.
- SSAO and any post pass.
- Save, load, autosave, recovery, the builds screen.
- Any UI: no top bar, no tool rail, no time-of-day slider. `?dev=sun` stands in.
- Thumbnails, cost, style match.

## Acceptance

- [ ] `npm test` and `npm run build` pass.
- [ ] **Render on demand:** a headless-Chromium smoke test loads the page, waits 3 s after the scene settles, and asserts `renderCount` stops increasing. This is the acceptance check that the whole §4.2 rule actually holds; a continuous loop passes every other test in this list.
- [ ] `renderCount` increases by exactly one per coalesced batch: two `setIn` calls inside one command produce one additional frame, not two.
- [ ] `computeSunPosition` tested as a pure function against fixed cases: noon at the equinox, sunrise and sunset elevations near zero, midnight below the horizon, a lot rotated 90° by `orientationDeg` moving the sun azimuth by 90°, and both solstices differing in the expected direction.
- [ ] Camera clamps tested: pitch cannot leave 10°–85°, zoom cannot leave 3–150 m, target cannot leave lot bounds + 10 m, from both keyboard and pointer input.
- [ ] The camera spring reaches rest and stops scheduling frames; a test asserts no frame is scheduled after settling.
- [ ] Camera keys do nothing while a text input has focus.
- [ ] Terrain mesh vertex count matches `(sizeX × res + 1) × (sizeZ × res + 1)` for at least three lot sizes from the §5 list, and vertex heights match the source heightmap.
- [ ] Changing lot size rebuilds terrain and grid, disposes the previous geometry, and does not leak: a test asserts the renderer's geometry and texture counts return to baseline after ten size changes.
- [ ] `sync.registerBuilder` dispatches only to the dirty categories; an unregistered category is a silent no-op; a `walls` change with no walls builder registered throws nothing and renders once.
- [ ] Preset switching applies the §8.3 values and disposes what the previous preset allocated.
- [ ] The adaptive pixel-ratio downgrade triggers under a simulated 25 ms frame time held for 2 s, and does not trigger at 15 ms.
- [ ] Headless smoke: canvas mounts, zero console errors, sky renders, grid renders, terrain renders, and the scene is visually checked in a screenshot in the Handoff.
- [ ] `?dev=sun` scrubs 0–24 and the sun visibly traverses; screenshots at 06:00, 12:00, and 21:00 in the Handoff.
- [ ] `src/client/dev/boot-cube.js` is gone and nothing references it.
- [ ] `docs/DEFERRED.md` no longer lists render on demand; `docs/PHASE0_RESULTS.md` notes what gate 1 now measures.
- [ ] No `TODO` in `src/`, no `localStorage`, no secrets.

## Handoff (Builder fills in)

### What changed

Nine new modules and the boot rewrite. `src/client/dev/boot-cube.js` is deleted.

Files: `src/client/engine/` — `sun.js`, `scheduler.js`, `presets.js`,
`renderer.js`, `sky.js`, `camera-math.js`, `camera.js`, `grid.js`, `sync.js`,
`scene.js`, `three.js` (all new); `src/client/geometry/terrain.js` (new);
`src/client/dev/sun-scrub.js` (new); `src/client/main.js`; `src/server/Code.gs`;
`src/server/Index.html`; four new test files; `docs/DEFERRED.md`;
`docs/PHASE0_RESULTS.md`; `CHANGELOG.md`; five screenshots.

**405 tests across 17 files**, up from 328. `npm run build` passes.

### Verified in the browser, because the headline requirement can only be

Render on demand is the one acceptance item that passes every unit test even
when it is completely broken, so it was measured against the real bundle in
headless Chromium:

| Check | Result |
|---|---|
| Frames after the scene settles | **1**, and still **1** after 3 s idle |
| Two `setIn` in one command | **1** frame, 1 `requestRender` |
| Two separate commands | **2** frames — batching, not a dropped render |
| Camera move, then idle | 14 frames of spring, then **0** |
| Geometry / texture count after 10 lot resizes | 5 / 1 → **5 / 1**, no leak |
| First render of the lot scene | 46 ms (software renderer) |
| Console | clean, no errors or warnings |

Screenshots: `008-lot-scene.png` (default view), `008-horizon.png` (low pitch,
sky and fog), and `008-sun-0600/1200/2100.png` for the `?dev=sun` traverse —
dawn orange at 11.5° elevation, clear blue at 83.4°, stars at −21.3°.

### Three defects the work surfaced

**1. The camera spring overshot by 10%.** My closed-form critically damped step
was missing the `−ω·v·t` term in the velocity, so the camera sailed past where
you let go and came back. Caught by a test that asserted no overshoot rather
than only that it settles. Fixing it also cut settling from 43 frames to 14 —
29 fewer frames rendered per camera nudge, which is the whole point of §4.2.

**2. Night was unreadable.** §8.1 asks for a "subtle `AmbientLight` at night for
readability"; at 0.25 the lot rendered black under ACES and the 0.55 night
exposure. Atmospheric and useless. The number is set by the word "readability",
so it is 0.9 and the screenshot shows a legible lot under stars.

**3. The `?dev=sun` readout lagged the scene.** It showed 00:10 while the sky was
at 21:00, because it painted from its own writes rather than from the store. It
now subscribes to `environment` changes, so any path that moves the sun updates
it. Worth recording: the first 21:00 screenshot looked plausible and was wrong,
and only the mismatch between the caption and the sky gave it away.

### Deviations and judgement calls

- **`computeSunPosition` lives in `engine/sun.js`, not inside `sky.js`.** §2 of
  the ticket requires it be "exported separately from anything touching
  Three.js"; a separate module makes that structural rather than a convention,
  and `sky.js` re-exports it so callers see one surface.
- **`camera-math.js` is split from `camera.js`** for the same reason: the clamps
  and the spring are the parts with acceptance criteria, and they test with no
  DOM and no GL.
- **`engine/scene.js` is a new file the ticket does not name.** Something has to
  own which builders exist and in what order; putting it in `main.js` would make
  boot untestable, and putting it in `sync.js` would defeat the registry.
- **The boot payload now carries the raw `dev` string.** `?dev=sun` needed a
  server change either way. Passing the string instead of adding `devSun`
  alongside `devGates` and `devGate3` means §18's `?dev=gallery` and `?dev=stats`
  need no further server update. Owner-only, as the other dev routes are.
- **The sky shader multiplies its colours by 1.75 before output.** ACES (§8.1)
  compresses midtones hard, and the palette names colours as the sky should
  *look*; without the lift a clear afternoon renders slate grey. The constant is
  named `ACES_GAIN` with the measurement in its comment rather than being an
  unexplained magic number in the shader.
- **The ground ring is a shade darker than the lot.** The buildable area has to
  read at a glance, and tinting is one fewer thing to keep in sync with the lot
  size than a boundary outline would be.
- **`store.deleteIn` is not used here.** Nothing in this ticket deletes; the
  lot-resize path replaces `lot.size` and rebuilds.

### One thing the Architect may want to look at

**At §6's default camera the sky is not visible.** `pitch: 0.62` is 35.5°; with a
50° vertical field of view the top of the frame sits about 10° *below* the
horizon, so the default view is entirely ground — `008-lot-scene.png` shows it.
Nothing is broken, the geometry is right, and orbiting down to about 0.25 rad
brings the horizon in (`008-horizon.png`). But the first frame a new user sees
has no sky in it, which undersells the thing and reads as a missing feature.

I have not changed it: `createBuildDocument` must match §6 character for
character, and the default camera is §6's. If the Architect agrees the default
should show the horizon, it is a one-number §6 amendment (pitch ≈ 0.35) and not
a code change.

### What the next ticket inherits

- `sync.registerBuilder(category, fn)` is how walls, roofs and objects attach.
  `sync.js` should not need editing again. **The builder owns disposal** — that
  contract is in its docstring and the ten-resize leak test is what keeps it
  honest.
- `view.requestRender()` is the only render trigger, and `sync.apply` is the only
  place that calls it on a store change. Keeping that to one call site is what
  makes the render-on-demand check above meaningful.
- `KS.scene` exposes `view`, `camera`, `sync`, `sky`, `terrain` and `grid` for
  the dev routes and the tests.
- Picking, double-click focus and the tools are still out; the camera claims
  right-drag and middle-drag and deliberately leaves left-drag alone for them.
