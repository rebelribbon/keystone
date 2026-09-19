// Save-format codec (SPEC §6.4): JSON -> UTF-8 -> gzip -> base64 -> chunks.
//
// Pure and importable under Node 20 for vitest: uses only CompressionStream /
// DecompressionStream, btoa / atob, Blob and Response, all of which Node 18+
// exposes globally.
//
// Base64 is processed in fixed-size windows. A single
// String.fromCharCode.apply over a multi-megabyte buffer overflows the call
// stack, and concatenating independently-encoded base64 windows is only valid
// when each window is a whole number of 3-byte groups — hence the window sizes
// below, which are not arbitrary.

/** Bytes per encode window. Must be a multiple of 3. */
const ENCODE_WINDOW_BYTES = 32760;

/** Characters per decode window. Must be a multiple of 4. */
const DECODE_WINDOW_CHARS = 65536;

/**
 * Run bytes through a transform stream and collect the result.
 * @param {Uint8Array} bytes
 * @param {TransformStream} transform
 * @returns {Promise<Uint8Array>}
 */
async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>} gzip bytes
 */
export function gzip(bytes) {
  return pipeThrough(bytes, new CompressionStream("gzip"));
}

/**
 * @param {Uint8Array} bytes gzip bytes
 * @returns {Promise<Uint8Array>}
 */
export function gunzip(bytes) {
  return pipeThrough(bytes, new DecompressionStream("gzip"));
}

/**
 * Base64-encode a byte array without blowing the call stack.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += ENCODE_WINDOW_BYTES) {
    const window = bytes.subarray(i, i + ENCODE_WINDOW_BYTES);
    out += btoa(String.fromCharCode.apply(null, window));
  }
  return out;
}

/**
 * Decode base64 produced by toBase64 (or by any standard encoder).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromBase64(text) {
  const parts = [];
  let total = 0;
  for (let i = 0; i < text.length; i += DECODE_WINDOW_CHARS) {
    const binary = atob(text.slice(i, i + DECODE_WINDOW_CHARS));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
    parts.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encode a Build document for upload: JSON -> UTF-8 -> gzip -> base64.
 * @param {*} doc
 * @returns {Promise<string>}
 */
export async function encodeDocument(doc) {
  const utf8 = new TextEncoder().encode(JSON.stringify(doc));
  return toBase64(await gzip(utf8));
}

/**
 * Reverse of encodeDocument.
 * @param {string} base64
 * @returns {Promise<*>}
 */
export async function decodeDocument(base64) {
  const bytes = await gunzip(fromBase64(base64));
  return JSON.parse(new TextDecoder().decode(bytes));
}
