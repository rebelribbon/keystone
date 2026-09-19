// Save transport (SPEC §6.4, §14.2): gzip -> base64 -> chunk -> upload -> commit.
import { gzip, toBase64 } from "./codec.js";
import { chunk, nextChunkSize, START_CHUNK_CHARS } from "./chunker.js";
import { callServer } from "./transport.js";

/**
 * Upload a build's bytes and commit them.
 *
 * On CHUNK_TOO_LARGE the chunk size halves and the upload restarts from a fresh
 * uploadId, so no partially-uploaded run at the old size is left staged in the
 * cache to be mistaken for the new one.
 *
 * @param {Uint8Array} bytes the serialized Build document
 * @param {Object} meta index-row fields (name, primaryStyle, levels, ...)
 * @param {{buildId?: string, thumbBase64?: string, chunkSize?: number,
 *          onProgress?: (p: Object) => void}} [options]
 * @returns {Promise<Object>} the commit result plus transport measurements
 */
export async function saveBuild(bytes, meta, options) {
  const opts = options || {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const started = Date.now();

  const compressed = await gzip(bytes);
  const base64 = toBase64(compressed);
  onProgress({ phase: "encoded", rawBytes: bytes.length, gzipBytes: compressed.length, base64Chars: base64.length });

  let size = opts.chunkSize || START_CHUNK_CHARS;
  let attempts = 0;

  for (;;) {
    attempts++;
    const pieces = chunk(base64, size);
    const begun = await callServer("api_beginSave", [opts.buildId || null, meta || {}]);
    const uploadId = begun.uploadId;

    let tooLarge = false;
    for (let i = 0; i < pieces.length; i++) {
      try {
        await callServer("api_saveChunk", [uploadId, i, pieces[i]]);
      } catch (err) {
        if (err && err.code === "CHUNK_TOO_LARGE") {
          tooLarge = true;
          break;
        }
        throw err;
      }
      onProgress({ phase: "upload", index: i + 1, total: pieces.length, chunkSize: size });
    }

    if (tooLarge) {
      size = nextChunkSize(size);
      onProgress({ phase: "resize", chunkSize: size });
      continue;
    }

    const committed = await callServer("api_commitSave", [uploadId, pieces.length, opts.thumbBase64 || null]);
    return Object.assign({}, committed, {
      chunkSize: size,
      chunkCount: pieces.length,
      uploadAttempts: attempts,
      rawBytes: bytes.length,
      gzipBytes: compressed.length,
      base64Chars: base64.length,
      seconds: (Date.now() - started) / 1000,
    });
  }
}
