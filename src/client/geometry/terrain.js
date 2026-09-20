// Terrain mesh (SPEC §5, §6, §8.1).
//
// Flat only in this ticket: the heightmap is read and honoured, but nothing
// writes to it yet. The vertex maths is pure and exported so it can be checked
// against the document without a GL context.
import { getTHREE } from "../engine/three.js";
import { base64ToBytes } from "../core/document.js";

/** §8.1: the ground continues past the lot, out to the fog. */
export const GROUND_RING_SIZE = 600;

/**
 * Pure. The §6 base64 heightmap as floats.
 * @param {string} base64
 * @returns {!Float32Array}
 */
export function decodeHeights(base64) {
  const bytes = base64ToBytes(base64);
  // Copy rather than view: base64ToBytes may hand back a buffer whose offset is
  // not 4-aligned, and Float32Array refuses that.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/**
 * Pure. Vertex data for the lot's terrain.
 *
 * §5: 1 tile = 1 m, Y up, origin at the lot's southwest corner, +X east,
 * +Z south. §6: `resolution` samples per tile, so the grid has
 * (sizeX·res + 1) × (sizeZ·res + 1) corners.
 *
 * @param {{sizeX: number, sizeZ: number, resolution: number, heights: !Float32Array}} lot
 * @returns {{positions: !Float32Array, uvs: !Float32Array, indices: !Uint32Array,
 *            cols: number, rows: number, vertexCount: number}}
 */
export function terrainVertexData({ sizeX, sizeZ, resolution, heights }) {
  const res = Math.max(1, Math.floor(resolution));
  const cols = sizeX * res + 1;
  const rows = sizeZ * res + 1;
  const vertexCount = cols * rows;

  if (heights && heights.length < vertexCount) {
    throw new Error(
      `terrain: heightmap has ${heights.length} samples, the ${sizeX}x${sizeZ} lot at ` +
        `resolution ${res} needs ${vertexCount}. The document and the lot size disagree.`
    );
  }

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = row * cols + col;
      positions[i * 3] = col / res;
      positions[i * 3 + 1] = heights ? heights[i] : 0;
      positions[i * 3 + 2] = row / res;
      uvs[i * 2] = col / (cols - 1 || 1);
      uvs[i * 2 + 1] = row / (rows - 1 || 1);
    }
  }

  let out = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Counter-clockwise seen from +Y, so the surface faces up.
      indices[out++] = a;
      indices[out++] = c;
      indices[out++] = b;
      indices[out++] = b;
      indices[out++] = c;
      indices[out++] = d;
    }
  }

  return { positions, uvs, indices, cols, rows, vertexCount };
}

/**
 * Build the lot terrain and its surrounding ground ring.
 *
 * @param {!Object} doc a §6 Build document
 * @returns {{group: !Object, dispose: function(): void}}
 */
export function buildTerrain(doc) {
  const THREE = getTHREE();
  const [sizeX, sizeZ] = doc.lot.size;
  const { resolution } = doc.lot.terrain;
  const heights = decodeHeights(doc.lot.terrain.heights);
  const data = terrainVertexData({ sizeX, sizeZ, resolution, heights });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // One flat material: the §6 splat layers ride along in the document and are
  // not rendered until the terrain paint ticket.
  const material = new THREE.MeshStandardMaterial({
    color: 0x8a9c6f,
    roughness: 1.0,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ks-terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // §8.1: neutral grass out to the horizon, sitting just below the lot so the
  // two never z-fight along the boundary.
  const ringGeometry = new THREE.PlaneGeometry(GROUND_RING_SIZE, GROUND_RING_SIZE);
  // Deliberately a shade darker than the lot: the buildable area has to read
  // at a glance, and a boundary line would be one more thing to keep in sync
  // with the lot size.
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0x63744f,
    roughness: 1.0,
    metalness: 0.0,
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.name = "ks-ground-ring";
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(sizeX / 2, -0.02, sizeZ / 2);
  ring.receiveShadow = true;

  const group = new THREE.Group();
  group.name = "ks-terrain-group";
  group.add(ring);
  group.add(mesh);

  return {
    group,
    mesh,
    data,
    dispose() {
      geometry.dispose();
      material.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      group.clear();
    },
  };
}
