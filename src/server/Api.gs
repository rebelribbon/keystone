/**
 * Api.gs — the §14.2 server API (SPEC §3, §14.2, §14.3).
 *
 * Plain Apps Script V8: no imports, no bundling, no npm.
 *
 * Every function follows the same shape: auth check first, try/catch, a
 * structured `{ code, message }` on failure, and a Log row on every write.
 * Reads are not logged — logging every page view or list call would bury the
 * Log tab (the same reasoning ticket 002 applied to granted access).
 *
 * These names deliberately carry no trailing underscore: Apps Script refuses to
 * expose `name_` to google.script.run, so a private name here would make the
 * function uncallable from the client.
 */

var KS_UPLOAD_TTL_SECONDS = 21600;

/**
 * The largest chunk one script-cache key will hold, in characters.
 *
 * The script cache caps a value at 100 KB. The client's ladder starts at 1.5 MB
 * (SPEC §6.4) and halves on rejection, so the first four rungs are refused
 * immediately and it settles on the 100 KB floor. Rejecting with a named code
 * is what lets the client act rather than fail opaquely.
 */
var KS_MAX_CHUNK_CHARS = 100000;

/** Download chunk cache TTL, matching the upload staging cache in 003. */
var KS_DOWNLOAD_TTL_SECONDS = 21600;

/**
 * Keys per `putAll` when priming the download cache.
 *
 * One `put` per chunk would be the same round-trip mistake the load path is
 * being fixed for, just on the server. Ten keys is 1 MB per call, which keeps a
 * comfortable margin under the payload cap while cutting 70 writes to 7.
 */
var KS_CACHE_PUT_BATCH = 10;

/* -------------------------------------------------------------------------
 * Download cache keys (ticket 005)
 * ---------------------------------------------------------------------- */

/**
 * Pure. A short, cache-key-safe stamp for a build revision.
 * Epoch milliseconds when `updated` parses as a date, otherwise the value with
 * everything but letters and digits stripped.
 * @param {*} updated
 * @return {string}
 */
function revisionStamp_(updated) {
  var parsed = toTime_(updated);
  if (!isNaN(parsed)) return String(parsed);
  return String(updated == null ? '' : updated).replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Pure. The download cache key base for one revision of one build.
 *
 * The revision stamp is what stops a re-saved build serving chunks from its
 * previous revision: a new `updated` produces a new key space, and the old
 * one simply ages out.
 * @param {string} buildId
 * @param {*} updated
 * @return {string}
 */
function downloadKeyBase_(buildId, updated) {
  return 'ks_dl_' + String(buildId) + '_' + revisionStamp_(updated);
}

/**
 * Pure. Is this a download key base the client may use for this build?
 *
 * The client hands `cacheKeyBase` back so the server can skip re-reading the
 * index row, which means it is caller-controlled input used to build a cache
 * key. Binding it to the `buildId` argument keeps a crafted value from reading
 * another key space — `ks_upload_*` or `ks_settings` — out of the shared script
 * cache. Validating the shape costs nothing; a Sheet read to recompute it would
 * cost exactly what this ticket is removing.
 * @param {*} cacheKeyBase
 * @param {*} buildId
 * @return {boolean}
 */
function isDownloadKeyBase_(cacheKeyBase, buildId) {
  var base = String(cacheKeyBase == null ? '' : cacheKeyBase);
  var id = String(buildId == null ? '' : buildId).trim();
  if (!id) return false;
  var prefix = 'ks_dl_' + id + '_';
  if (base.indexOf(prefix) !== 0) return false;
  return /^[A-Za-z0-9]+$/.test(base.slice(prefix.length));
}

/* -------------------------------------------------------------------------
 * Plumbing
 * ---------------------------------------------------------------------- */

/**
 * Resolve the caller's access decision. Never throws, and never turns an
 * unreadable `Users` tab into a denial (ticket 006).
 * @return {{allowed: boolean, status: string, email: string, role: ?string, code: ?string, reason: string}}
 */
function requireAccess_() {
  var email = activeEmail_();
  var roleResult;
  try {
    roleResult = getUserRole_(email);
  } catch (err) {
    // getUserRole_ already swallows its own failures; this is the belt to that
    // braces. A throw from here is still not evidence about the access list.
    roleResult = { status: 'unavailable', role: null, reason: describeError_(err) };
  }
  return decideAccess_(email, roleResult);
}

/**
 * The structured error for a refused access decision (SPEC §14.2).
 *
 * `AUTH_UNAVAILABLE` is deliberately a different code from `ACCESS_DENIED`: the
 * client retries the first and surfaces the second, and a reader of the Log can
 * tell an outage from a wall of genuine denials.
 * @param {!Object} access
 * @return {?{code: string, message: string}} null when access is allowed
 */
function accessError_(access) {
  if (access && access.allowed) return null;
  if (access && access.status === 'unavailable') {
    return {
      code: 'AUTH_UNAVAILABLE',
      message: 'Keystone could not check the access list just now. Try again in a moment. ' +
        'Reported: ' + String(access.reason || 'unknown')
    };
  }
  return { code: 'ACCESS_DENIED', message: 'This Google account is not on the Keystone access list.' };
}

/**
 * Wrap an API body with the auth check and error contract.
 * @param {function(!Object):*} body
 * @return {*}
 */
function apiCall_(body) {
  var access = requireAccess_();
  if (!access.allowed) {
    if (access.status === 'unavailable') {
      logRow_(access.email, 'auth_unavailable', '', 'reason=' + access.reason);
    }
    return accessError_(access);
  }
  try {
    return body(access);
  } catch (err) {
    return {
      code: (err && err.ksCode) || 'INTERNAL',
      message: err && err.message ? String(err.message) : String(err)
    };
  }
}

/**
 * A short id for a new build (SPEC §6: type-prefixed short random strings).
 * @return {string}
 */
function newBuildId_() {
  var alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var out = '';
  for (var i = 0; i < 8; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return 'b_' + out;
}

/** @return {string} */
function newUploadId_() {
  return 'u_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
}

/** @return {string} */
function uploadMetaKey_(uploadId) {
  return 'ks_upload_' + uploadId;
}

/** @return {string} */
function uploadChunkKey_(uploadId, index) {
  return 'ks_upload_' + uploadId + '_' + index;
}

/* -------------------------------------------------------------------------
 * §14.2 functions
 * ---------------------------------------------------------------------- */

/**
 * Who is signed in. Moved here from Code.gs in ticket 003 so the whole §14 API
 * lives in one file (SPEC §3).
 * @return {{email: string, role: string}|{code: string, message: string}}
 */
function api_whoami() {
  return apiCall_(function (access) {
    return { email: access.email, role: access.role };
  });
}

/**
 * Every non-deleted build, newest first.
 * @return {!Array<!Object>|{code: string, message: string}}
 */
function api_listBuilds() {
  return apiCall_(function () {
    return listBuildRows_();
  });
}

/**
 * Open an upload. A null buildId means a new build and the server mints the id.
 * @param {?string} buildId
 * @param {Object} meta
 * @return {{uploadId: string, buildId: string}|{code: string, message: string}}
 */
function api_beginSave(buildId, meta) {
  return apiCall_(function (access) {
    var id = String(buildId == null ? '' : buildId).trim() || newBuildId_();
    var uploadId = newUploadId_();
    // The upload cache is the store for a save in progress, not an
    // optimization over one, so a write that does not land is reported rather
    // than swallowed: the alternative is a save that looks fine until commit
    // and then reports missing chunks.
    var staged = cachePut_(
      uploadMetaKey_(uploadId),
      JSON.stringify({ buildId: id, meta: meta || {}, email: access.email, startedAt: new Date().toISOString() }),
      KS_UPLOAD_TTL_SECONDS
    );
    if (!staged) {
      throw ksError_('CACHE_WRITE_FAILED', 'The upload could not be opened because the script cache refused the write.');
    }
    return { uploadId: uploadId, buildId: id };
  });
}

/**
 * Stage one base64 chunk.
 * @param {string} uploadId
 * @param {number} index
 * @param {string} base64
 * @return {{ok: boolean}|{code: string, message: string}}
 */
function api_saveChunk(uploadId, index, base64) {
  return apiCall_(function () {
    var text = String(base64 == null ? '' : base64);
    if (text.length > KS_MAX_CHUNK_CHARS) {
      throw ksError_(
        'CHUNK_TOO_LARGE',
        'Chunk of ' + text.length + ' characters exceeds the ' + KS_MAX_CHUNK_CHARS +
          ' character cache limit. Halve the chunk size and retry.'
      );
    }
    if (!cacheGet_(uploadMetaKey_(uploadId))) {
      throw ksError_('UPLOAD_EXPIRED', 'This upload is unknown or has expired. Start the save again.');
    }
    if (!cachePut_(uploadChunkKey_(uploadId, index), text, KS_UPLOAD_TTL_SECONDS)) {
      throw ksError_('CACHE_WRITE_FAILED', 'Chunk ' + index + ' could not be staged because the script cache refused the write.');
    }
    return { ok: true };
  });
}

/**
 * Assemble the staged chunks, write the Drive file, and update the index row.
 * Runs under a script lock so two saves cannot interleave on the same row.
 * @param {string} uploadId
 * @param {number} totalChunks
 * @param {?string} thumbBase64
 * @return {!Object|{code: string, message: string}}
 */
function api_commitSave(uploadId, totalChunks, thumbBase64) {
  return apiCall_(function (access) {
    var raw = cacheGet_(uploadMetaKey_(uploadId));
    if (!raw) {
      throw ksError_('UPLOAD_EXPIRED', 'This upload is unknown or has expired. Start the save again.');
    }
    var upload = JSON.parse(raw);
    var meta = upload.meta || {};
    var count = Number(totalChunks) || 0;
    if (count <= 0) throw ksError_('UPLOAD_EMPTY', 'The upload staged no chunks.');

    var keys = [];
    for (var i = 0; i < count; i++) keys.push(uploadChunkKey_(uploadId, i));
    var found = cacheGetAll_(keys);
    var parts = [];
    for (var j = 0; j < count; j++) {
      var piece = found[uploadChunkKey_(uploadId, j)];
      if (piece == null) {
        throw ksError_('CHUNK_MISSING', 'Chunk ' + j + ' of ' + count + ' is missing or expired. Start the save again.');
      }
      parts.push(piece);
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var nowIso = new Date().toISOString();
      var existing = readBuildRow_(upload.buildId);

      if (existing && isConflict_(meta.baseUpdated, existing.build.updated)) {
        var copyId = newBuildId_();
        var copyFile = writeBuildFile_(copyId, Utilities.base64Decode(parts.join('')));
        appendBuildRow_({
          buildId: copyId,
          name: String(meta.name || existing.build.name || 'Build') + ' (conflict copy)',
          owner: access.email,
          primaryStyle: meta.primaryStyle || existing.build.primaryStyle || '',
          levels: meta.levels || existing.build.levels || '',
          estCostLow: meta.estCostLow || '',
          estCostHigh: meta.estCostHigh || '',
          created: nowIso,
          updated: nowIso,
          driveFileId: copyFile.getId(),
          thumbFileId: '',
          schema: meta.schema || 1,
          deleted: ''
        });
        logRow_(access.email, 'save', copyId, 'conflict copy of ' + upload.buildId);
        return { conflict: true, buildId: copyId, updated: nowIso, driveFileId: copyFile.getId() };
      }

      var file = writeBuildFile_(upload.buildId, Utilities.base64Decode(parts.join('')));
      var driveFileId = file.getId();

      if (existing) {
        existing.build.name = meta.name || existing.build.name || 'Build';
        existing.build.owner = existing.build.owner || access.email;
        existing.build.primaryStyle = meta.primaryStyle || existing.build.primaryStyle || '';
        existing.build.levels = meta.levels || existing.build.levels || '';
        existing.build.estCostLow = meta.estCostLow || existing.build.estCostLow || '';
        existing.build.estCostHigh = meta.estCostHigh || existing.build.estCostHigh || '';
        existing.build.updated = nowIso;
        existing.build.driveFileId = driveFileId;
        existing.build.schema = meta.schema || existing.build.schema || 1;
        existing.build.deleted = '';
        writeBuildRow_(existing);
      } else {
        appendBuildRow_({
          buildId: upload.buildId,
          name: meta.name || 'Build',
          owner: access.email,
          primaryStyle: meta.primaryStyle || '',
          levels: meta.levels || '',
          estCostLow: meta.estCostLow || '',
          estCostHigh: meta.estCostHigh || '',
          created: nowIso,
          updated: nowIso,
          driveFileId: driveFileId,
          thumbFileId: '',
          schema: meta.schema || 1,
          deleted: ''
        });
      }

      logRow_(access.email, 'save', upload.buildId, count + ' chunks');
      return { conflict: false, buildId: upload.buildId, updated: nowIso, driveFileId: driveFileId };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * Write every chunk of an already-encoded build into the script cache.
 *
 * Batched, and deliberately failure-tolerant: a cache write that does not land
 * must degrade to slow reads, never to an error. Correctness never depends on
 * the cache being warm.
 * @param {string} cacheKeyBase
 * @param {string} base64
 * @param {number} total
 */
function primeDownloadCache_(cacheKeyBase, base64, total) {
  var batch = {};
  var pending = 0;

  for (var i = 0; i < total; i++) {
    batch[cacheKeyBase + '_' + i] = base64.substr(i * KS_MAX_CHUNK_CHARS, KS_MAX_CHUNK_CHARS);
    pending++;
    if (pending === KS_CACHE_PUT_BATCH) {
      cachePutAll_(batch, KS_DOWNLOAD_TTL_SECONDS);
      batch = {};
      pending = 0;
    }
  }
  if (pending) cachePutAll_(batch, KS_DOWNLOAD_TTL_SECONDS);
}

/**
 * A build's index row, how many chunks its file takes, and the key base its
 * chunks are cached under.
 *
 * The full Drive read and base64 encode happen here, once. Ticket 003 paid for
 * that pass and threw the result away, leaving `api_loadChunk` to repeat it per
 * call; ticket 005 keeps it and populates the cache with it instead.
 * @param {string} buildId
 * @return {{meta: !Object, totalChunks: number, cacheKeyBase: string}|{code: string, message: string}}
 */
function api_loadBuildInfo(buildId) {
  return apiCall_(function () {
    var row = readBuildRow_(buildId);
    if (!row) throw ksError_('BUILD_NOT_FOUND', 'No build with that id.');

    var base64 = Utilities.base64Encode(readBuildFile_(row.build.driveFileId));
    var total = Math.ceil(base64.length / KS_MAX_CHUNK_CHARS);
    var cacheKeyBase = downloadKeyBase_(row.build.buildId, row.build.updated);

    primeDownloadCache_(cacheKeyBase, base64, total);

    return {
      meta: row.build,
      totalChunks: total,
      base64Chars: base64.length,
      cacheKeyBase: cacheKeyBase
    };
  });
}

/**
 * One base64 chunk of a build's file, from the cache when it is there.
 *
 * `cacheKeyBase` is optional. Omitting it, or missing the cache for any reason
 * — eviction, TTL expiry, a caller that skipped api_loadBuildInfo — falls back
 * to the original read-and-encode path and produces identical bytes, just
 * slowly. That equivalence is the property the whole design rests on, and
 * tests/server-logic.test.js asserts the two paths byte-for-byte.
 * @param {string} buildId
 * @param {number} index
 * @param {string=} cacheKeyBase
 * @return {{chunk: string, cached: boolean}|{code: string, message: string}}
 */
function api_loadChunk(buildId, index, cacheKeyBase) {
  return apiCall_(function () {
    var idx = Number(index) || 0;

    if (isDownloadKeyBase_(cacheKeyBase, buildId)) {
      var hit = cacheGet_(cacheKeyBase + '_' + idx);
      if (hit !== null && hit !== undefined) {
        return { chunk: hit, cached: true };
      }
    }

    var row = readBuildRow_(buildId);
    if (!row) throw ksError_('BUILD_NOT_FOUND', 'No build with that id.');

    var base64 = Utilities.base64Encode(readBuildFile_(row.build.driveFileId));
    var start = idx * KS_MAX_CHUNK_CHARS;
    if (start >= base64.length) {
      throw ksError_('CHUNK_OUT_OF_RANGE', 'Chunk ' + index + ' is past the end of this build.');
    }
    var chunk = base64.substr(start, KS_MAX_CHUNK_CHARS);

    // Re-populate only the key that missed; re-priming the whole build here
    // would turn one slow read into one slow read plus a full cache rewrite.
    cachePut_(
      downloadKeyBase_(row.build.buildId, row.build.updated) + '_' + idx,
      chunk,
      KS_DOWNLOAD_TTL_SECONDS
    );

    return { chunk: chunk, cached: false };
  });
}

/**
 * Owner-only: drop one download chunk from the cache so the fallback path can
 * be exercised on a live deployment (`?dev=gate3&evict=N`).
 *
 * The name carries no trailing underscore on purpose. Ticket 005 spells it
 * `api_devEvictChunk_`, but Apps Script will not expose a name ending in an
 * underscore to google.script.run, and the gate 3 harness calls this from the
 * page — the same defect ticket 003 fixed in `api_getBundle`.
 * @param {string} cacheKeyBase
 * @param {number} index
 * @return {{ok: boolean, evicted: number}|{code: string, message: string}}
 */
function api_devEvictChunk(cacheKeyBase, index) {
  return apiCall_(function (access) {
    if (access.role !== 'owner') {
      throw ksError_('FORBIDDEN', 'Only the owner can evict cache entries.');
    }
    var base = String(cacheKeyBase == null ? '' : cacheKeyBase);
    if (!/^ks_dl_[A-Za-z0-9_]+$/.test(base)) {
      throw ksError_('BAD_REQUEST', 'cacheKeyBase must be a download cache key base.');
    }
    var idx = Number(index) || 0;
    cacheRemove_(base + '_' + idx);
    return { ok: true, evicted: idx };
  });
}

/**
 * Soft delete: set `deleted`, move the Drive file into Trash.
 * @param {string} buildId
 * @return {{ok: boolean, buildId: string}|{code: string, message: string}}
 */
function api_deleteBuild(buildId) {
  return apiCall_(function (access) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var row = readBuildRow_(buildId);
      if (!row) throw ksError_('BUILD_NOT_FOUND', 'No build with that id.');
      moveBuildFileToTrash_(row.build.driveFileId);
      row.build.deleted = 'true';
      row.build.updated = new Date().toISOString();
      writeBuildRow_(row);
      logRow_(access.email, 'delete', row.build.buildId, 'soft delete');
      return { ok: true, buildId: row.build.buildId };
    } finally {
      lock.releaseLock();
    }
  });
}

/**
 * The Settings tab as an object.
 * @return {!Object|{code: string, message: string}}
 */
function api_getSettings() {
  return apiCall_(function () {
    return getSettings_();
  });
}

/**
 * Set one setting. Owner only. Invalidates the settings cache.
 * @param {string} key
 * @param {string} value
 * @return {{ok: boolean}|{code: string, message: string}}
 */
function api_setSetting(key, value) {
  return apiCall_(function (access) {
    if (access.role !== 'owner') {
      throw ksError_('FORBIDDEN', 'Only the owner can change settings.');
    }
    var name = String(key == null ? '' : key).trim();
    writeSetting_(name, value);
    logRow_(access.email, 'setting', '', name);
    return { ok: true };
  });
}
