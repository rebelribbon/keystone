// Graphics presets (SPEC §8.3).
//
// The table is data, not branching: every consumer reads the same object, so
// adding a preset is one entry rather than a hunt through the renderer.

/**
 * @typedef {{
 *   id: string, label: string,
 *   shadows: boolean, shadowMapSize: number,
 *   post: {wants: ?string, enabled: boolean},
 *   pixelRatioCap: number,
 *   textureSize: number, heroTextureSize: number
 * }} Preset
 */

/**
 * §8.3, exactly.
 *
 * High's post slot says it *wants* SSAO and is switched off: SSAO is Phase 6,
 * and a stub pass that renders nothing is worse than an honest flag — it looks
 * implemented in a profile and hides the fact that nothing is happening.
 * @type {!Object<string, Preset>}
 */
export const PRESETS = Object.freeze({
  low: Object.freeze({
    id: "low",
    label: "Low",
    shadows: false,
    shadowMapSize: 0,
    post: Object.freeze({ wants: null, enabled: false }),
    pixelRatioCap: 1,
    textureSize: 512,
    heroTextureSize: 512,
  }),
  medium: Object.freeze({
    id: "medium",
    label: "Medium",
    shadows: true,
    shadowMapSize: 1024,
    post: Object.freeze({ wants: null, enabled: false }),
    pixelRatioCap: 1.5,
    textureSize: 1024,
    heroTextureSize: 1024,
  }),
  high: Object.freeze({
    id: "high",
    label: "High",
    shadows: true,
    shadowMapSize: 2048,
    post: Object.freeze({ wants: "ssao", enabled: false }),
    pixelRatioCap: 2,
    textureSize: 1024,
    heroTextureSize: 2048,
  }),
});

export const DEFAULT_PRESET = "high";

/**
 * Pure. Look up a preset, falling back to the default rather than throwing —
 * an unknown value in a saved setting should degrade the picture, not the app.
 * @param {string} id
 * @returns {Preset}
 */
export function getPreset(id) {
  const key = String(id == null ? "" : id).toLowerCase();
  return PRESETS[key] || PRESETS[DEFAULT_PRESET];
}

/**
 * Apply a preset to the renderer and sun.
 *
 * Disposing the old shadow map matters: Three keeps the render target alive on
 * the light, so switching High → Low without this leaks a 2048² depth texture
 * for the rest of the session.
 * @param {!Object} renderer THREE.WebGLRenderer
 * @param {!Object} sun THREE.DirectionalLight
 * @param {Preset} preset
 * @param {{devicePixelRatio?: number}} [options]
 * @returns {Preset}
 */
export function applyPreset(renderer, sun, preset, options = {}) {
  const { devicePixelRatio = 1 } = options;

  renderer.shadowMap.enabled = preset.shadows;
  renderer.setPixelRatio(Math.min(devicePixelRatio, preset.pixelRatioCap));

  if (sun) {
    sun.castShadow = preset.shadows;
    if (sun.shadow && sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    if (preset.shadows && sun.shadow) {
      sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      if (sun.shadow.camera) sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.needsUpdate = true;
    }
  }

  // Three caches compiled programs keyed partly on shadow settings; without
  // this the scene keeps rendering with the old preset's shaders.
  if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
  return preset;
}
