// Renderer, lights and shadows (SPEC §8.1, §4.2).
//
// Lifted out of the Phase 0 boot cube and generalized. The scheduling half of
// §4.2 lives in scheduler.js; this file owns the GL objects and the lights.
import { getTHREE } from "./three.js";
import { createRenderScheduler, createPixelRatioGovernor } from "./scheduler.js";
import { getPreset, applyPreset } from "./presets.js";

/** Shadow frustum padding around the lot, in metres. */
export const SHADOW_PADDING = 12;

/**
 * Pure. A directional-light shadow frustum that fits the lot (§4.2).
 *
 * Recomputed on a lot-size change and not per frame: the lot does not move, and
 * a frustum recomputed every frame is a shadow map that shimmers as the camera
 * orbits.
 * @param {!Array<number>} lotSize [sizeX, sizeZ] tiles
 * @returns {{left: number, right: number, top: number, bottom: number,
 *            near: number, far: number, radius: number, center: !Array<number>}}
 */
export function shadowFrustumForLot(lotSize) {
  const [sizeX, sizeZ] = lotSize;
  const half = Math.max(sizeX, sizeZ) / 2 + SHADOW_PADDING;
  const radius = Math.hypot(sizeX, sizeZ) / 2 + SHADOW_PADDING;
  return {
    left: -half,
    right: half,
    top: half,
    bottom: -half,
    near: 0.5,
    far: radius * 4,
    radius,
    center: [sizeX / 2, 0, sizeZ / 2],
  };
}

/**
 * Create the renderer, its scene, its lights, and the render-on-demand loop.
 *
 * @param {{host: !HTMLElement, presetId?: string, window?: !Object}} options
 */
export function createRenderer(options) {
  const THREE = getTHREE();
  const { host, presetId, window: win = window } = options;

  let preset = getPreset(presetId);

  let renderer = null;
  let contextLossHandler = null;
  let contextRestoreHandler = null;

  const scene = new THREE.Scene();
  scene.name = "ks-scene";

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  camera.name = "ks-camera";

  // §8.1 lights: sun, hemisphere bounce, and a little ambient so night is
  // readable rather than black.
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.name = "ks-sun";
  sun.castShadow = true;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  const hemisphere = new THREE.HemisphereLight(0xbcd7ff, 0x6b6250, 1.0);
  hemisphere.name = "ks-hemi";
  scene.add(hemisphere);

  const ambient = new THREE.AmbientLight(0x8fa6bf, 0.02);
  ambient.name = "ks-ambient";
  scene.add(ambient);

  // §8.1: fog to the horizon, recoloured with the sky.
  scene.fog = new THREE.Fog(0xbcd7ea, 120, 900);

  function buildRenderer() {
    const created = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    created.outputColorSpace = THREE.SRGBColorSpace;
    created.toneMapping = THREE.ACESFilmicToneMapping;
    created.toneMappingExposure = 1.0;
    created.shadowMap.enabled = preset.shadows;
    created.shadowMap.type = THREE.PCFSoftShadowMap;
    created.setPixelRatio(Math.min(win.devicePixelRatio || 1, preset.pixelRatioCap));
    host.appendChild(created.domElement);
    return created;
  }

  renderer = buildRenderer();
  applyPreset(renderer, sun, preset, { devicePixelRatio: win.devicePixelRatio || 1 });

  /** Callbacks run immediately before each frame — the camera spring uses this. */
  const beforeRender = new Set();

  const scheduler = createRenderScheduler({
    requestFrame: (fn) => win.requestAnimationFrame(fn),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
    now: () => (win.performance ? win.performance.now() : Date.now()),
    render: () => {
      for (const hook of Array.from(beforeRender)) hook();
      renderer.render(scene, camera);
    },
  });

  const governor = createPixelRatioGovernor({
    cap: preset.pixelRatioCap,
    current: Math.min(win.devicePixelRatio || 1, preset.pixelRatioCap),
    onChange: (ratio) => {
      renderer.setPixelRatio(ratio);
      resize();
    },
  });
  scheduler.onFrame((frameMs, nowMs) => governor.sample(frameMs, nowMs));

  function resize() {
    const width = host.clientWidth || win.innerWidth || 1;
    const height = host.clientHeight || win.innerHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    scheduler.requestRender();
  }

  function onResize() {
    resize();
  }
  win.addEventListener("resize", onResize);
  resize();

  /**
   * Fit the sun's shadow camera to the lot (§4.2).
   * @param {!Array<number>} lotSize
   */
  function fitShadowToLot(lotSize) {
    const frustum = shadowFrustumForLot(lotSize);
    const shadowCamera = sun.shadow.camera;
    shadowCamera.left = frustum.left;
    shadowCamera.right = frustum.right;
    shadowCamera.top = frustum.top;
    shadowCamera.bottom = frustum.bottom;
    shadowCamera.near = frustum.near;
    shadowCamera.far = frustum.far;
    shadowCamera.updateProjectionMatrix();
    sun.target.position.set(frustum.center[0], frustum.center[1], frustum.center[2]);
    sun.target.updateMatrixWorld();
    return frustum;
  }

  /**
   * Point the sun and colour the lights from a sky palette (§8.1, §8.2).
   * @param {{sun: !Object, palette: !Object}} sky the result of sky.apply()
   * @param {!Array<number>} lotSize
   */
  function applySky(sky, lotSize) {
    const frustum = shadowFrustumForLot(lotSize);
    const distance = frustum.radius * 2.2;
    const { direction } = sky.sun;
    sun.position.set(
      frustum.center[0] + direction.x * distance,
      Math.max(direction.y * distance, 1),
      frustum.center[2] + direction.z * distance
    );
    sun.intensity = sky.palette.sunIntensity;
    sun.color.set(sky.palette.sunTint);
    hemisphere.intensity = sky.palette.hemiIntensity;
    hemisphere.color.set(sky.palette.zenith);
    hemisphere.groundColor.set(sky.palette.horizon);
    ambient.intensity = sky.palette.ambientIntensity;
    renderer.toneMappingExposure = sky.palette.exposure;
    if (scene.fog) scene.fog.color.set(sky.palette.fog);
    // The sun stops casting below the horizon — a shadow map from underground
    // throws light-leaking artefacts across the lot.
    sun.castShadow = preset.shadows && sky.sun.aboveHorizon;
  }

  /**
   * Switch graphics preset (§8.3), disposing what the old one allocated.
   * @param {string} id
   */
  function setPreset(id) {
    preset = getPreset(id);
    applyPreset(renderer, sun, preset, { devicePixelRatio: win.devicePixelRatio || 1 });
    governor.reset(Math.min(win.devicePixelRatio || 1, preset.pixelRatioCap));
    resize();
    return preset;
  }

  /**
   * Rebuild after a lost WebGL context.
   *
   * Three does not recover on its own; without this the canvas stays black for
   * the rest of the session and looks like the app crashed.
   */
  function handleContextLoss(event) {
    event.preventDefault();
  }

  function handleContextRestore() {
    const old = renderer.domElement;
    renderer.dispose();
    if (old.parentNode === host) host.removeChild(old);
    detachContextHandlers();
    renderer = buildRenderer();
    attachContextHandlers();
    applyPreset(renderer, sun, preset, { devicePixelRatio: win.devicePixelRatio || 1 });
    governor.reset(Math.min(win.devicePixelRatio || 1, preset.pixelRatioCap));
    resize();
  }

  function attachContextHandlers() {
    contextLossHandler = handleContextLoss;
    contextRestoreHandler = handleContextRestore;
    renderer.domElement.addEventListener("webglcontextlost", contextLossHandler, false);
    renderer.domElement.addEventListener("webglcontextrestored", contextRestoreHandler, false);
  }

  function detachContextHandlers() {
    if (!contextLossHandler) return;
    renderer.domElement.removeEventListener("webglcontextlost", contextLossHandler);
    renderer.domElement.removeEventListener("webglcontextrestored", contextRestoreHandler);
    contextLossHandler = null;
    contextRestoreHandler = null;
  }

  attachContextHandlers();

  return {
    scene,
    camera,
    sun,
    hemisphere,
    ambient,
    get renderer() {
      return renderer;
    },
    get preset() {
      return preset;
    },
    get pixelRatio() {
      return governor.ratio;
    },
    get renderCount() {
      return scheduler.renderCount;
    },
    get requestCount() {
      return scheduler.requestCount;
    },
    requestRender: scheduler.requestRender,
    onBeforeRender(hook) {
      beforeRender.add(hook);
      return () => beforeRender.delete(hook);
    },
    onFrame: scheduler.onFrame,
    resize,
    fitShadowToLot,
    applySky,
    setPreset,
    governor,
    dispose() {
      scheduler.dispose();
      win.removeEventListener("resize", onResize);
      detachContextHandlers();
      beforeRender.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    },
  };
}
