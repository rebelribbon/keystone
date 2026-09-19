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
 * The largest chunk one CacheService key will hold, in characters.
 *
 * CacheService caps a value at 100 KB. The client's ladder starts at 1.5 MB
 * (SPEC §6.4) and halves on rejection, so the first four rungs are refused
 * immediately and it settles on the 100 KB floor. Rejecting with a named code
 * is what lets the client act rather than fail opaquely.
 */
var KS_MAX_CHUNK_CHARS = 100000;

/* -------------------------------------------------------------------------
 * Plumbing
 * ---------------------------------------------------------------------- */

/**
 * Resolve the caller and refuse anyone without a Users row.
 * @return {{allowed: boolean, email: string, role: ?string}}
 */
function requireAccess_() {
  var email = activeEmail_();
  var role = null;
  try {
    role = getUserRole_(email);
  } catch (err) {
    role = null;
  }
  return decideAccess_(email, role);
}

/**
 * Wrap an API body with the auth check and error contract.
 * @param {function(!Object):*} body
 * @return {*}
 */
function apiCall_(body) {
  var access;
  try {
    access = requireAccess_();
  } catch (err) {
    return { code: 'INTERNAL', message: 'Could not resolve the signed-in account.' };
  }
  if (!access.allowed) {
    return { code: 'ACCESS_DENIED', message: 'This Google account is not on the Keystone access list.' };
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
    CacheService.getScriptCache().put(
      uploadMetaKey_(uploadId),
      JSON.stringify({ buildId: id, meta: meta || {}, email: access.email, startedAt: new Date().toISOString() }),
      KS_UPLOAD_TTL_SECONDS
    );
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
    var cache = CacheService.getScriptCache();
    if (!cache.get(uploadMetaKey_(uploadId))) {
      throw ksError_('UPLOAD_EXPIRED', 'This upload is unknown or has expired. Start the save again.');
    }
    cache.put(uploadChunkKey_(uploadId, index), text, KS_UPLOAD_TTL_SECONDS);
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
    var cache = CacheService.getScriptCache();
    var raw = cache.get(uploadMetaKey_(uploadId));
    if (!raw) {
      throw ksError_('UPLOAD_EXPIRED', 'This upload is unknown or has expired. Start the save again.');
    }
    var upload = JSON.parse(raw);
    var meta = upload.meta || {};
    var count = Number(totalChunks) || 0;
    if (count <= 0) throw ksError_('UPLOAD_EMPTY', 'The upload staged no chunks.');

    var keys = [];
    for (var i = 0; i < count; i++) keys.push(uploadChunkKey_(uploadId, i));
    var found = cache.getAll(keys) || {};
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
 * A build's index row plus how many chunks its file will take.
 * @param {string} buildId
 * @return {{meta: !Object, totalChunks: number}|{code: string, message: string}}
 */
function api_loadBuildInfo(buildId) {
  return apiCall_(function () {
    var row = readBuildRow_(buildId);
    if (!row) throw ksError_('BUILD_NOT_FOUND', 'No build with that id.');
    var base64 = Utilities.base64Encode(readBuildFile_(row.build.driveFileId));
    return {
      meta: row.build,
      totalChunks: Math.ceil(base64.length / KS_MAX_CHUNK_CHARS),
      base64Chars: base64.length
    };
  });
}

/**
 * One base64 chunk of a build's file.
 * @param {string} buildId
 * @param {number} index
 * @return {string|{code: string, message: string}}
 */
function api_loadChunk(buildId, index) {
  return apiCall_(function () {
    var row = readBuildRow_(buildId);
    if (!row) throw ksError_('BUILD_NOT_FOUND', 'No build with that id.');
    var base64 = Utilities.base64Encode(readBuildFile_(row.build.driveFileId));
    var start = (Number(index) || 0) * KS_MAX_CHUNK_CHARS;
    if (start >= base64.length) {
      throw ksError_('CHUNK_OUT_OF_RANGE', 'Chunk ' + index + ' is past the end of this build.');
    }
    return base64.substr(start, KS_MAX_CHUNK_CHARS);
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
    if (!name) throw ksError_('BAD_REQUEST', 'A settings key is required.');

    var sheet = SpreadsheetApp.getActive().getSheetByName('Settings');
    if (!sheet) throw ksError_('SETTINGS_TAB_MISSING', 'The Settings tab is missing.');
    var values = sheet.getDataRange().getValues() || [];
    var rowNumber = 0;
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] == null ? '' : values[i][0]).trim() === name) {
        rowNumber = i + 1;
        break;
      }
    }
    if (rowNumber) {
      sheet.getRange(rowNumber, 2).setValue(value);
    } else {
      sheet.appendRow([name, value]);
    }
    invalidateSettings_();
    logRow_(access.email, 'setting', '', name);
    return { ok: true };
  });
}
