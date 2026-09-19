// Upload chunking and the halving ladder (SPEC §6.4, §14.2).
//
// CacheService caps what one key can hold well below the 1.5 MB the spec names,
// so the client starts there, halves on a CHUNK_TOO_LARGE rejection, and stops
// at a 100 KB floor. Sizes are decimal (1 MB = 1,000,000), which is what makes
// the ladder land on the 750 / 375 / 187 KB rungs.

/** Starting chunk size in characters: 1.5 MB. */
export const START_CHUNK_CHARS = 1500000;

/** Floor chunk size in characters: 100 KB. */
export const MIN_CHUNK_CHARS = 100000;

/**
 * Split a string into fixed-size pieces. The final piece may be shorter.
 * @param {string} text
 * @param {number} size
 * @returns {string[]}
 */
export function chunk(text, size) {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("chunk: size must be a positive number");
  }
  const value = String(text == null ? "" : text);
  const out = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

/**
 * The next rung down the ladder. Halves, clamping to the floor.
 * Throws at the floor rather than looping forever.
 * @param {number} current
 * @returns {number}
 */
export function nextChunkSize(current) {
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error("nextChunkSize: current must be a positive number");
  }
  if (current <= MIN_CHUNK_CHARS) {
    throw new Error(
      `Upload failed at the minimum chunk size (${MIN_CHUNK_CHARS} characters). ` +
        "The server rejected even the smallest chunk, so this is not a size problem."
    );
  }
  const halved = Math.floor(current / 2);
  return halved < MIN_CHUNK_CHARS ? MIN_CHUNK_CHARS : halved;
}
