// The Build document (SPEC §6). Shape, IDs, and serialization.
//
// §6's JSON is the schema. Field names, nesting, and types here match it
// exactly; changing any of them is a spec change first (§0.2), not a code
// change.

/** Bumping this ships a migration (§0.2, §6.4). */
export const SCHEMA_VERSION = 1;

/** §6 type prefixes. Every minted ID carries one. */
export const ID_PREFIXES = Object.freeze({
  build: "b_",
  level: "lv_",
  node: "n_",
  wall: "w_",
  room: "r_",
  roof: "rf_",
  opening: "op_",
  object: "o_",
});

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Length of the random part of an ID.
 *
 * §6's example (`b_7Hq2kd`) is six characters. Eight is used instead: a large
 * build reaches ~10,000 IDs, and at six characters the birthday collision
 * probability is around 1 in 1,000 — too high for identifiers that have to
 * survive a save, a load, and a future merge. Eight puts it near 1 in 4 million.
 * The prefix and the character set are unchanged, so IDs still read the way §6
 * shows them.
 */
const ID_LENGTH = 8;

/** Random bytes, from the platform CSPRNG when there is one. */
function randomBytes(count) {
  const out = new Uint8Array(count);
  const crypto = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < count; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * Mint a short, type-prefixed ID (§6).
 *
 * Deliberately not a counter: IDs have to stay unique across a save/load cycle
 * and across two documents merged together, and a counter restarts at zero in
 * both of those cases.
 * @param {string} prefix one of ID_PREFIXES, or any `xx_` prefix
 * @returns {string}
 */
export function newId(prefix) {
  const head = String(prefix == null ? "" : prefix);
  if (!/^[a-z]{1,3}_$/.test(head)) {
    throw new Error(`newId: "${head}" is not a §6 type prefix (letters then underscore)`);
  }
  const bytes = randomBytes(ID_LENGTH);
  let tail = "";
  for (let i = 0; i < ID_LENGTH; i += 1) {
    tail += ID_ALPHABET.charAt(bytes[i] % ID_ALPHABET.length);
  }
  return head + tail;
}

/**
 * Base64 of a typed array's bytes, chunked so a large heightmap does not blow
 * the argument limit on String.fromCharCode.
 * @param {ArrayBufferView} view
 * @returns {string}
 */
export function bytesToBase64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Inverse of bytesToBase64.
 * @param {string} base64
 * @returns {!Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(String(base64 == null ? "" : base64));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** §6 default terrain resolution: samples per tile edge. */
export const TERRAIN_RESOLUTION = 2;

/** §6 terrain paint: four layers, the first fully weighted on a new lot. */
export const DEFAULT_TERRAIN_LAYERS = Object.freeze([
  "terrain.grass_lush",
  "terrain.dirt",
  "terrain.gravel",
  "terrain.sand",
]);

/**
 * A flat heightmap for a lot, base64 per §6.
 * Sample count is (sizeX*res+1)*(sizeZ*res+1) — grid corners, not cells.
 * @param {number} sizeX tiles
 * @param {number} sizeZ tiles
 * @param {number} resolution
 * @returns {string}
 */
export function flatHeightmap(sizeX, sizeZ, resolution) {
  const count = (sizeX * resolution + 1) * (sizeZ * resolution + 1);
  return bytesToBase64(new Float32Array(count));
}

/**
 * A splat map with layer 0 at full weight, base64 per §6.
 * §6 specifies 4 px per tile: a `res`×`res` block of RGBA per tile.
 * @param {number} sizeX tiles
 * @param {number} sizeZ tiles
 * @param {number} resolution
 * @returns {string}
 */
export function baseSplat(sizeX, sizeZ, resolution) {
  const pixels = sizeX * resolution * sizeZ * resolution;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) rgba[i * 4] = 255;
  return bytesToBase64(rgba);
}

/**
 * A complete, valid, empty Build document (§6).
 *
 * Every field §6 lists is present, including the ones nothing reads yet
 * (`platforms`, `fences`, `stairs`, `trim`) — an absent field and an empty one
 * are different things to a migration written two phases from now.
 *
 * @param {{name?: string, lotSize?: [number, number], primaryStyle?: string,
 *          owner?: string, units?: string, now?: string}} [options]
 * @returns {!Object}
 */
export function createBuildDocument(options = {}) {
  const {
    name = "Untitled Build",
    lotSize = [40, 30],
    primaryStyle = "",
    owner = "",
    units = "imperial",
    now = new Date().toISOString(),
  } = options;

  const [sizeX, sizeZ] = lotSize;
  if (!Number.isFinite(sizeX) || !Number.isFinite(sizeZ) || sizeX <= 0 || sizeZ <= 0) {
    throw new Error(`createBuildDocument: lotSize must be two positive numbers, got ${JSON.stringify(lotSize)}`);
  }

  return {
    schema: SCHEMA_VERSION,
    meta: {
      id: newId(ID_PREFIXES.build),
      name,
      owner,
      created: now,
      updated: now,
      primaryStyle,
      // Filled in by the loader from the registry once packs exist (§10.2).
      packs: {},
      units,
      regionCostMultiplier: 1.0,
    },
    lot: {
      size: [sizeX, sizeZ],
      orientationDeg: 0,
      environment: { timeOfDay: 16.5, latitude: 30, season: "summer", skyPreset: "clear" },
      terrain: {
        resolution: TERRAIN_RESOLUTION,
        heights: flatHeightmap(sizeX, sizeZ, TERRAIN_RESOLUTION),
        paint: {
          layers: DEFAULT_TERRAIN_LAYERS.slice(),
          splat: baseSplat(sizeX, sizeZ, TERRAIN_RESOLUTION),
        },
      },
    },
    levels: [
      {
        // lv_0 is the ground level and §6 names it literally, so it is not minted.
        id: "lv_0",
        index: 0,
        wallHeight: 3.05,
        foundation: { type: "slab", height: 0, materialId: null },
        nodes: {},
        walls: {},
        rooms: {},
        floorTiles: {},
        platforms: {},
        openings: {},
        fences: {},
        stairs: {},
        trim: { spandrel: null, frieze: null, foundationTrim: null },
      },
    ],
    roofs: {},
    objects: {},
    paths: {},
    pools: {},
    camera: {
      target: [sizeX / 2, 0, sizeZ / 2],
      distance: 38,
      yaw: 0.78,
      pitch: 0.62,
      levelIndex: 0,
      wallMode: "cutaway",
    },
  };
}

/** True for a plain object, i.e. one whose keys can be reordered safely. */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A structural copy with every plain object's keys in codepoint order.
 * Arrays keep their order — in §6 an array is data (a polygon, a size), never a
 * map.
 */
function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedClone(value[key]);
  return out;
}

/**
 * Document → JSON string, byte-stable.
 *
 * Key order is sorted rather than insertion-ordered so that two documents with
 * the same content always produce the same bytes. Without it, a save that
 * changed nothing still produces a different gzip and a new Drive file, and
 * "did this build actually change" stops being answerable by comparing digests.
 * @param {!Object} doc
 * @returns {string}
 */
export function serialize(doc) {
  return JSON.stringify(sortedClone(doc));
}

/**
 * JSON string → document.
 * @param {string} text
 * @returns {!Object}
 */
export function deserialize(text) {
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) {
    throw new Error("deserialize: expected a JSON object");
  }
  return parsed;
}
