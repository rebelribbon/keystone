// Load transport (SPEC §6.4, §14.2): chunks -> base64 -> gunzip.
import { gunzip, fromBase64 } from "./codec.js";
import { callServer } from "./transport.js";

/**
 * Pull a build back down and decompress it.
 *
 * `api_loadBuildInfo` returns a `cacheKeyBase`, which every `api_loadChunk`
 * call passes straight back so the server can serve from its chunk cache
 * instead of re-reading and re-encoding the whole Drive file per chunk
 * (ticket 005). Passing it is an optimization only — omit it, or miss the
 * cache, and the server returns identical bytes by the slow path.
 *
 * @param {string} buildId
 * @param {{onProgress?: (p: Object) => void,
 *          onInfo?: (info: Object) => (void|Promise<void>),
 *          forceCold?: boolean}} [options]
 * @returns {Promise<{bytes: Uint8Array, meta: Object, chunkCount: number,
 *                    seconds: number, chunkMs: number[],
 *                    cacheHits: number, cacheMisses: number}>}
 */
export async function loadBuild(buildId, options) {
  const opts = options || {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const started = Date.now();

  const info = await callServer("api_loadBuildInfo", [buildId]);

  // Hook for the gate harness: lets it evict a chunk after the cache is primed
  // but before any chunk is fetched, which is the only way to exercise the
  // fallback path on a live deployment.
  if (typeof opts.onInfo === "function") await opts.onInfo(info);

  const total = info.totalChunks || 0;
  const cacheKeyBase = opts.forceCold ? null : info.cacheKeyBase || null;
  const parts = [];
  const chunkMs = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (let i = 0; i < total; i++) {
    const startedChunk = Date.now();
    const result = await callServer("api_loadChunk", [buildId, i, cacheKeyBase]);
    chunkMs.push(Date.now() - startedChunk);

    // Tolerate a bare string as well as { chunk, cached }: a deployment running
    // an older Api.gs than this bundle still loads, it just cannot report hits.
    if (typeof result === "string") {
      parts.push(result);
    } else {
      parts.push(result.chunk);
      if (result.cached) cacheHits++;
      else cacheMisses++;
    }
    onProgress({ phase: "download", index: i + 1, total, ms: chunkMs[i] });
  }

  const bytes = await gunzip(fromBase64(parts.join("")));
  return {
    bytes,
    meta: info.meta || {},
    chunkCount: total,
    seconds: (Date.now() - started) / 1000,
    chunkMs,
    cacheHits,
    cacheMisses,
  };
}
