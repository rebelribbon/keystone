// The build grid (SPEC §5, §12).
//
// Visual only. Snapping lives in the tools that arrive later; this is the
// reference the eye uses to judge where a wall will land.
import { getTHREE } from "./three.js";

/** Half-tile lines appear below this camera distance, in metres. */
export const HALF_TILE_DISTANCE = 28;

/** The grid fades rather than vanishing as the camera pitches toward level. */
export const MIN_GRID_OPACITY = 0.2;
export const MAX_GRID_OPACITY = 0.6;

/**
 * Pure. Line-segment endpoints for a grid over the lot, on the ground plane.
 *
 * `offset` shifts the lines off the whole-tile positions, which is how the
 * half-tile set is generated without a second code path.
 * @param {number} sizeX tiles
 * @param {number} sizeZ tiles
 * @param {number} step metres between lines
 * @param {number} [offset] metres
 * @returns {!Float32Array} xyz triples, two per segment
 */
export function gridLinePositions(sizeX, sizeZ, step, offset = 0) {
  const xs = [];
  for (let x = offset; x <= sizeX + 1e-9; x += step) if (x >= 0) xs.push(x);
  const zs = [];
  for (let z = offset; z <= sizeZ + 1e-9; z += step) if (z >= 0) zs.push(z);

  const out = new Float32Array((xs.length + zs.length) * 6);
  let i = 0;
  for (const x of xs) {
    out[i++] = x; out[i++] = 0; out[i++] = 0;
    out[i++] = x; out[i++] = 0; out[i++] = sizeZ;
  }
  for (const z of zs) {
    out[i++] = 0; out[i++] = 0; out[i++] = z;
    out[i++] = sizeX; out[i++] = 0; out[i++] = z;
  }
  return out;
}

/**
 * Pure. Grid opacity for a camera pitch.
 *
 * §5's grid is a depth cue, and at a low pitch a full-strength grid turns into
 * a moiré haze across the whole ground plane. Dimming keeps the ground readable
 * instead of hiding the grid entirely, which would lose the cue exactly when
 * the view is most foreshortened.
 * @param {number} pitchRadians
 * @returns {number}
 */
export function gridOpacityForPitch(pitchRadians) {
  const t = Math.max(0, Math.min(1, Math.sin(pitchRadians)));
  return MIN_GRID_OPACITY + (MAX_GRID_OPACITY - MIN_GRID_OPACITY) * t;
}

/**
 * Build the grid for a lot.
 * @param {!Object} doc a §6 Build document
 */
export function buildGrid(doc) {
  const THREE = getTHREE();
  const [sizeX, sizeZ] = doc.lot.size;

  const disposables = [];

  function lines(step, offset, color, opacity) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(gridLinePositions(sizeX, sizeZ, step, offset), 3)
    );
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    disposables.push(geometry, material);
    const segments = new THREE.LineSegments(geometry, material);
    // Just above the terrain, or the lines z-fight with the ground they mark.
    segments.position.y = 0.012;
    return { segments, material };
  }

  const full = lines(1, 0, 0x27303a, MAX_GRID_OPACITY);
  full.segments.name = "ks-grid-full";

  const half = lines(1, 0.5, 0x27303a, MAX_GRID_OPACITY * 0.45);
  half.segments.name = "ks-grid-half";
  half.segments.visible = false;

  // §5: the lot origin is the southwest corner, and everything in the document
  // is measured from it. Marking it makes that legible without a HUD.
  const originGeometry = new THREE.BufferGeometry();
  originGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2]),
      3
    )
  );
  const originMaterial = new THREE.LineBasicMaterial({ color: 0xc39a3e, transparent: true, opacity: 0.9 });
  disposables.push(originGeometry, originMaterial);
  const origin = new THREE.LineSegments(originGeometry, originMaterial);
  origin.name = "ks-grid-origin";
  origin.position.y = 0.014;

  const group = new THREE.Group();
  group.name = "ks-grid";
  group.add(full.segments, half.segments, origin);

  return {
    group,
    /**
     * Track the camera: half-tile lines near, dimmer at a low pitch.
     * @param {{distance: number, pitch: number}} camera
     */
    update(camera) {
      half.segments.visible = camera.distance <= HALF_TILE_DISTANCE;
      const opacity = gridOpacityForPitch(camera.pitch);
      full.material.opacity = opacity;
      half.material.opacity = opacity * 0.45;
    },
    dispose() {
      for (const item of disposables) item.dispose();
      group.clear();
    },
  };
}
