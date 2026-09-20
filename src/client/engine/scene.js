// Scene assembly (SPEC §4.1).
//
// The wiring the other engine modules deliberately do not know about: which
// builders exist, what order they run in, and who owns disposal. Keeping it
// here means renderer.js, sync.js and camera.js each stay testable alone.
import { createRenderer } from "./renderer.js";
import { createCameraController } from "./camera.js";
import { createSceneSync } from "./sync.js";
import { buildSky } from "./sky.js";
import { buildGrid } from "./grid.js";
import { buildTerrain } from "../geometry/terrain.js";

/**
 * Build the lot scene from a store and mount it in `host`.
 *
 * @param {{host: !HTMLElement, store: !Object, events?: !Object,
 *          presetId?: string, window?: !Object, document?: !Object}} options
 */
export function createLotScene(options) {
  const { host, store, events = null, presetId, window: win = window, document: doc = document } = options;

  const view = createRenderer({ host, presetId, window: win });
  const sky = buildSky();
  view.scene.add(sky.group);

  let terrain = null;
  let grid = null;
  let lotKey = "";

  /** Rebuild terrain and grid. Both are lot-shaped, so they rebuild together. */
  function rebuildLot() {
    const document_ = store.getDocument();
    if (terrain) {
      view.scene.remove(terrain.group);
      terrain.dispose();
    }
    if (grid) {
      view.scene.remove(grid.group);
      grid.dispose();
    }
    terrain = buildTerrain(document_);
    grid = buildGrid(document_);
    view.scene.add(terrain.group, grid.group);
    view.fitShadowToLot(document_.lot.size);
    lotKey = document_.lot.size.join("x");
    grid.update(camera.state);
  }

  function applyEnvironment() {
    const document_ = store.getDocument();
    const applied = sky.apply(document_.lot.environment, document_.lot.orientationDeg);
    view.applySky(applied, document_.lot.size);
    return applied;
  }

  const camera = createCameraController({
    camera: view.camera,
    domElement: view.renderer.domElement,
    store,
    requestRender: view.requestRender,
    window: win,
    document: doc,
  });

  // The camera advances inside the frame it asked for, so its spring and the
  // render it triggers stay in step.
  view.onBeforeRender(() => {
    const now = win.performance ? win.performance.now() : Date.now();
    camera.update(now);
    if (grid) grid.update(camera.state);
  });

  const sync = createSceneSync({ store, requestRender: view.requestRender });

  // §4.1 builders. Only these four exist in this ticket; walls, roofs and
  // objects register their own later without touching sync.js.
  sync.registerBuilder("terrain", rebuildLot);
  sync.registerBuilder("levels", () => {
    // A level edit only reshapes the ground when the lot itself resized.
    const next = store.getDocument().lot.size.join("x");
    if (next !== lotKey) rebuildLot();
  });
  sync.registerBuilder("environment", applyEnvironment);
  sync.registerBuilder("camera", () => camera.fromDocument(store.getDocument().camera));
  sync.start();

  rebuildLot();
  applyEnvironment();
  view.requestRender();

  return {
    view,
    camera,
    sync,
    sky,
    get terrain() {
      return terrain;
    },
    get grid() {
      return grid;
    },
    applyEnvironment,
    rebuildLot,
    setPreset(id) {
      const preset = view.setPreset(id);
      view.requestRender();
      return preset;
    },
    dispose() {
      sync.dispose();
      camera.dispose();
      if (terrain) terrain.dispose();
      if (grid) grid.dispose();
      sky.dispose();
      view.dispose();
      if (events) events.removeAll("store:change");
    },
  };
}
