// Load transport (SPEC §6.4, §14.2): chunks -> base64 -> gunzip.
import { gunzip, fromBase64 } from "./codec.js";
import { callServer } from "./transport.js";

/**
 * Pull a build back down and decompress it.
 * @param {string} buildId
 * @param {{onProgress?: (p: Object) => void}} [options]
 * @returns {Promise<{bytes: Uint8Array, meta: Object, chunkCount: number, seconds: number}>}
 */
export async function loadBuild(buildId, options) {
  const opts = options || {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const started = Date.now();

  const info = await callServer("api_loadBuildInfo", [buildId]);
  const total = info.totalChunks || 0;
  const parts = [];

  for (let i = 0; i < total; i++) {
    parts.push(await callServer("api_loadChunk", [buildId, i]));
    onProgress({ phase: "download", index: i + 1, total });
  }

  const bytes = await gunzip(fromBase64(parts.join("")));
  return {
    bytes,
    meta: info.meta || {},
    chunkCount: total,
    seconds: (Date.now() - started) / 1000,
  };
}
