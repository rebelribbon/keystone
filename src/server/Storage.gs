/**
 * Storage.gs — Sheet read helpers (SPEC §14.1).
 *
 * Ticket 002 scope: Settings, Users, and Log only. The Drive and Builds
 * functions land in ticket 003 in this same file.
 *
 * Plain Apps Script V8: no imports, no bundling, no npm. Every pure helper
 * (parseSettingsRows_, findRole_) keeps Apps Script globals out of its body so
 * tests/server-logic.test.js can evaluate this file as text and call them.
 */

var KS_SETTINGS_CACHE_KEY = 'ks_settings';
var KS_USER_CACHE_PREFIX = 'ks_user_';
var KS_SHEET_CACHE_TTL_SECONDS = 300;

/**
 * How long an authorization answer stays cached, by outcome (ticket 006 §4).
 *
 * A granted answer is stable and worth 300 s. A denial is not: the owner adds a
 * row to `Users` precisely because someone was denied, and a five-minute
 * negative TTL means the fix appears not to work. Thirty seconds keeps the
 * Sheet read off the hot path without making the owner wait out a stale no.
 */
var KS_ROLE_OK_TTL_SECONDS = 300;
var KS_ROLE_DENIED_TTL_SECONDS = 30;

var KS_USERS_TAB = 'Users';

var KS_VALID_ROLES = ['owner', 'editor', 'viewer'];

/**
 * Pure. Turn `Settings` rows (key | value) into a plain object.
 * Skips the header row and any row with a blank key. Values are trimmed.
 * @param {Array<Array<*>>} rows
 * @return {!Object<string,string>}
 */
function parseSettingsRows_(rows) {
  var out = {};
  if (!rows || !rows.length) return out;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || [];
    var key = String(row[0] == null ? '' : row[0]).trim();
    if (!key) continue;
    if (i === 0 && key.toLowerCase() === 'key') continue;
    out[key] = String(row[1] == null ? '' : row[1]).trim();
  }
  return out;
}

/**
 * Pure. Find a user's role in `Users` rows (email | role | addedOn).
 * Email comparison is trimmed and lowercased on both sides.
 * @param {Array<Array<*>>} rows
 * @param {string} email
 * @return {?string} 'owner' | 'editor' | 'viewer' | null
 */
function findRole_(rows, email) {
  var want = String(email == null ? '' : email).trim().toLowerCase();
  if (!want || !rows || !rows.length) return null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || [];
    var candidate = String(row[0] == null ? '' : row[0]).trim().toLowerCase();
    if (!candidate || candidate === 'email') continue;
    if (candidate !== want) continue;
    var role = String(row[1] == null ? '' : row[1]).trim().toLowerCase();
    return KS_VALID_ROLES.indexOf(role) === -1 ? null : role;
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Script cache (ticket 006)
 *
 * Every cache interaction in src/server/ goes through these five helpers, and
 * `CacheService` is named exactly once, in ksCache_. A cache is an optimization:
 * when it fails, the caller must fall back to the slow path that was always
 * there. The one outcome a cache failure must never produce is a different
 * answer, and in the auth path "no role" is a different answer — it is the one
 * that tells a listed user they are not on the list.
 *
 * None of these throw. A read failure is a miss; a write failure is a false
 * return the caller may ignore.
 * ---------------------------------------------------------------------- */

/**
 * The script cache, or null when even acquiring it fails.
 * @return {?Object}
 */
function ksCache_() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    console.error('ksCache_ could not acquire the script cache: ' + describeError_(err));
    return null;
  }
}

/**
 * One cached value, or null on a miss or any thrown error.
 * @param {string} key
 * @return {?string}
 */
function cacheGet_(key) {
  var cache = ksCache_();
  if (!cache) return null;
  try {
    var value = cache.get(key);
    return value === undefined ? null : value;
  } catch (err) {
    console.error('cacheGet_("' + key + '") threw, treating as a miss: ' + describeError_(err));
    return null;
  }
}

/**
 * Several cached values at once. Returns a partial object rather than throwing,
 * so a caller that needs every key finds a hole and takes its slow path.
 * @param {!Array<string>} keys
 * @return {!Object<string,string>}
 */
function cacheGetAll_(keys) {
  var cache = ksCache_();
  if (!cache) return {};
  try {
    return cache.getAll(keys) || {};
  } catch (err) {
    console.error('cacheGetAll_ threw, treating as a miss: ' + describeError_(err));
    return {};
  }
}

/**
 * Write one value. Never propagates.
 * @param {string} key
 * @param {string} value
 * @param {number} ttlSeconds
 * @return {boolean} true when the write landed
 */
function cachePut_(key, value, ttlSeconds) {
  var cache = ksCache_();
  if (!cache) return false;
  try {
    cache.put(key, value, ttlSeconds);
    return true;
  } catch (err) {
    console.error('cachePut_("' + key + '") failed: ' + describeError_(err));
    return false;
  }
}

/**
 * Write several values in one call. Never propagates.
 * @param {!Object<string,string>} obj
 * @param {number} ttlSeconds
 * @return {boolean} true when the write landed
 */
function cachePutAll_(obj, ttlSeconds) {
  var cache = ksCache_();
  if (!cache) return false;
  try {
    cache.putAll(obj, ttlSeconds);
    return true;
  } catch (err) {
    console.error('cachePutAll_ failed: ' + describeError_(err));
    return false;
  }
}

/**
 * Drop one key. Never propagates.
 * @param {string} key
 * @return {boolean} true when the removal landed
 */
function cacheRemove_(key) {
  var cache = ksCache_();
  if (!cache) return false;
  try {
    cache.remove(key);
    return true;
  } catch (err) {
    console.error('cacheRemove_("' + key + '") failed: ' + describeError_(err));
    return false;
  }
}

/**
 * Read every populated row of a tab. Returns [] when the tab is missing.
 * @param {string} tabName
 * @return {Array<Array<*>>}
 */
function readSheetRows_(tabName) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sheet) return [];
  var range = sheet.getDataRange();
  if (!range) return [];
  return range.getValues() || [];
}

/**
 * The `Settings` tab as a key/value object, cached for 300 s.
 * @return {!Object<string,string>}
 */
function getSettings_() {
  var hit = cacheGet_(KS_SETTINGS_CACHE_KEY);
  if (hit) {
    try {
      return JSON.parse(hit);
    } catch (err) {
      cacheRemove_(KS_SETTINGS_CACHE_KEY);
    }
  }
  var settings = parseSettingsRows_(readSheetRows_('Settings'));
  cachePut_(KS_SETTINGS_CACHE_KEY, JSON.stringify(settings), KS_SHEET_CACHE_TTL_SECONDS);
  return settings;
}

/**
 * One setting, or `fallback` when the key is absent or blank.
 * @param {string} key
 * @param {string=} fallback
 * @return {string}
 */
function getSetting_(key, fallback) {
  var value = getSettings_()[key];
  if (value === undefined || value === null || value === '') {
    return fallback === undefined ? '' : fallback;
  }
  return value;
}

/** Drop the cached `Settings` object so the next read hits the Sheet. */
function invalidateSettings_() {
  cacheRemove_(KS_SETTINGS_CACHE_KEY);
}

/**
 * Write one `Settings` key, updating the row in place or appending it, and drop
 * the cache so the next read sees it.
 *
 * Extracted from `api_setSetting` in ticket 004 so the updater's `server_tag`
 * and `server_fingerprint` writes go through the same upsert instead of a second
 * copy of it. The caller does the authorization; this does not.
 * @param {string} key
 * @param {*} value
 */
function writeSetting_(key, value) {
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
}

/**
 * The cache key holding one account's authorization answer.
 * @param {string} normalizedEmail already trimmed and lowercased
 * @return {string}
 */
function userCacheKey_(normalizedEmail) {
  return KS_USER_CACHE_PREFIX + normalizedEmail;
}

/**
 * Every populated row of the `Users` tab. Throws when the tab cannot be read.
 *
 * Deliberately not `readSheetRows_`, which answers a missing tab with `[]`. An
 * empty array is indistinguishable from a tab full of other people's rows, so
 * routing the auth path through it turns "the Users tab is gone" into "you are
 * not on the list" — the whole defect this ticket exists for.
 * @return {!Array<Array<*>>}
 */
function readUsersRows_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(KS_USERS_TAB);
  if (!sheet) {
    throw ksError_('USERS_TAB_MISSING', 'The Users tab is missing from the Keystone Index sheet.');
  }
  var range = sheet.getDataRange();
  if (!range) {
    throw ksError_('USERS_RANGE_MISSING', 'The Users tab returned no data range.');
  }
  return range.getValues() || [];
}

/**
 * A user's authorization answer as a tri-state (ticket 006 §2).
 *
 *   { status: 'ok', role }            the tab was read and the email matched
 *   { status: 'denied', reason }      the tab was read and nothing matched
 *   { status: 'unavailable', reason } the tab could not be read at all
 *
 * The third is not an answer and callers must never render it as one. The cache
 * is never the source of an answer on its own: a miss or a cache error falls
 * through to the Sheet, and only a successful Sheet read produces `ok` or
 * `denied`. Never throws.
 * @param {string} email
 * @return {{status: string, role: ?string, reason: string}}
 */
function getUserRole_(email) {
  var normalized = String(email == null ? '' : email).trim().toLowerCase();
  if (!normalized) {
    // Nothing to look up. This is a real answer and needs no Sheet read.
    return { status: 'denied', role: null, reason: 'no_email' };
  }

  var key = userCacheKey_(normalized);
  var hit = cacheGet_(key);
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      if (cached && cached.status === 'ok' && KS_VALID_ROLES.indexOf(cached.role) !== -1) {
        return { status: 'ok', role: cached.role, reason: 'cached' };
      }
      if (cached && cached.status === 'denied') {
        return { status: 'denied', role: null, reason: 'not_listed' };
      }
    } catch (err) {
      cacheRemove_(key);
    }
  }

  var rows;
  try {
    rows = readUsersRows_();
  } catch (err) {
    // Never cached: an unreadable tab is not an answer, and caching it would
    // extend one transient failure across every request for its whole TTL.
    return { status: 'unavailable', role: null, reason: describeError_(err) };
  }

  var role = findRole_(rows, normalized);
  var answer = role
    ? { status: 'ok', role: role, reason: 'listed' }
    : { status: 'denied', role: null, reason: 'not_listed' };
  cachePut_(
    key,
    JSON.stringify({ status: answer.status, role: answer.role }),
    role ? KS_ROLE_OK_TTL_SECONDS : KS_ROLE_DENIED_TTL_SECONDS
  );
  return answer;
}

/**
 * Append one row to the `Log` tab. Never throws into the caller.
 * @param {string} email
 * @param {string} action
 * @param {string} buildId
 * @param {string} detail
 */
function logRow_(email, action, buildId, detail) {
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Log');
    if (!sheet) return;
    sheet.appendRow([
      new Date(),
      String(email == null ? '' : email),
      String(action == null ? '' : action),
      String(buildId == null ? '' : buildId),
      String(detail == null ? '' : detail)
    ]);
  } catch (err) {
    console.error('logRow_ failed: ' + err);
  }
}

/* -------------------------------------------------------------------------
 * Builds tab and Drive (ticket 003, SPEC §6.4, §14.1)
 * ---------------------------------------------------------------------- */

var KS_BUILDS_TAB = 'Builds';
var KS_TRASH_FOLDER = 'Trash';

/** The §14.1 header order, used only when the tab has no header row yet. */
var KS_BUILDS_COLUMNS = [
  'buildId', 'name', 'owner', 'primaryStyle', 'levels', 'estCostLow', 'estCostHigh',
  'created', 'updated', 'driveFileId', 'thumbFileId', 'schema', 'deleted'
];

/**
 * An error carrying a structured code for the API layer.
 * @param {string} code
 * @param {string} message
 * @return {!Error}
 */
function ksError_(code, message) {
  var err = new Error(message);
  err.ksCode = code;
  return err;
}

/**
 * Pure. Map a `Builds` row onto an object using the sheet's own header order,
 * so reordering columns in the Sheet cannot silently shift the data.
 * @param {Array<*>} header
 * @param {Array<*>} row
 * @return {!Object}
 */
function rowToBuild_(header, row) {
  var head = header || [];
  var source = row || [];
  var out = {};
  for (var i = 0; i < head.length; i++) {
    var key = String(head[i] == null ? '' : head[i]).trim();
    if (!key) continue;
    out[key] = i < source.length && source[i] != null ? source[i] : '';
  }
  return out;
}

/**
 * Pure. Lay an object out in the sheet's own header order. Columns the object
 * does not carry are written blank rather than skipped, so the row stays
 * aligned with the header.
 * @param {Array<*>} header
 * @param {!Object} obj
 * @return {!Array<*>}
 */
function buildToRow_(header, obj) {
  var head = header || [];
  var source = obj || {};
  var row = [];
  for (var i = 0; i < head.length; i++) {
    var key = String(head[i] == null ? '' : head[i]).trim();
    var has = key && Object.prototype.hasOwnProperty.call(source, key) && source[key] != null;
    row.push(has ? source[key] : '');
  }
  return row;
}

/**
 * Pure. Milliseconds for a Date or an ISO string; NaN when unusable.
 * @param {*} value
 * @return {number}
 */
function toTime_(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (Object.prototype.toString.call(value) === '[object Date]') return value.getTime();
  var parsed = Date.parse(String(value));
  return isNaN(parsed) ? NaN : parsed;
}

/**
 * Pure. Does the server's row post-date what the client based its edit on?
 *
 * A client that sends no `baseUpdated` against an existing row is treated as a
 * conflict: it cannot prove it saw the current state, and silently clobbering
 * someone else's save is the one outcome worth refusing (SPEC §14.2).
 * @param {*} baseUpdated
 * @param {*} serverUpdated
 * @return {boolean}
 */
function isConflict_(baseUpdated, serverUpdated) {
  var server = toTime_(serverUpdated);
  if (isNaN(server)) return false;
  var base = toTime_(baseUpdated);
  if (isNaN(base)) return true;
  return server > base;
}

/**
 * The `Builds` tab with its header and data rows.
 * @return {{sheet: !Object, header: !Array<*>, rows: !Array<Array<*>>}}
 */
function readBuildsSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(KS_BUILDS_TAB);
  if (!sheet) {
    throw ksError_('BUILDS_TAB_MISSING', 'The Builds tab is missing from the Keystone Index sheet.');
  }
  var values = sheet.getDataRange().getValues() || [];
  var header = values.length && String(values[0][0] || '').trim() ? values[0] : KS_BUILDS_COLUMNS.slice();
  return { sheet: sheet, header: header, rows: values.length ? values.slice(1) : [] };
}

/**
 * Index of a named column in the sheet's header.
 * @param {Array<*>} header
 * @param {string} name
 * @return {number}
 */
function buildsColumnIndex_(header, name) {
  var head = header || [];
  for (var i = 0; i < head.length; i++) {
    if (String(head[i] == null ? '' : head[i]).trim() === name) return i;
  }
  throw ksError_('BUILDS_HEADER_INVALID', 'The Builds tab has no "' + name + '" column.');
}

/**
 * One build's row, or null when the id is not in the tab.
 * @param {string} buildId
 * @return {?{build: !Object, rowNumber: number, header: !Array<*>, sheet: !Object}}
 */
function readBuildRow_(buildId) {
  var want = String(buildId == null ? '' : buildId).trim();
  if (!want) return null;
  var table = readBuildsSheet_();
  var idIndex = buildsColumnIndex_(table.header, 'buildId');
  for (var i = 0; i < table.rows.length; i++) {
    var cell = String(table.rows[i][idIndex] == null ? '' : table.rows[i][idIndex]).trim();
    if (cell !== want) continue;
    return {
      build: rowToBuild_(table.header, table.rows[i]),
      rowNumber: i + 2,
      header: table.header,
      sheet: table.sheet
    };
  }
  return null;
}

/**
 * Write an existing row back in place.
 * @param {{build: !Object, rowNumber: number, header: !Array<*>, sheet: !Object}} row
 */
function writeBuildRow_(row) {
  var values = buildToRow_(row.header, row.build);
  row.sheet.getRange(row.rowNumber, 1, 1, values.length).setValues([values]);
}

/**
 * Append a new build row.
 * @param {!Object} build
 */
function appendBuildRow_(build) {
  var table = readBuildsSheet_();
  table.sheet.appendRow(buildToRow_(table.header, build));
}

/**
 * Every non-deleted build, newest `updated` first.
 * @return {!Array<!Object>}
 */
function listBuildRows_() {
  var table = readBuildsSheet_();
  var out = [];
  for (var i = 0; i < table.rows.length; i++) {
    var build = rowToBuild_(table.header, table.rows[i]);
    if (!String(build.buildId || '').trim()) continue;
    if (String(build.deleted || '').trim().toLowerCase() === 'true') continue;
    out.push(build);
  }
  out.sort(function (a, b) {
    var at = toTime_(a.updated);
    var bt = toTime_(b.updated);
    if (isNaN(at) && isNaN(bt)) return 0;
    if (isNaN(at)) return 1;
    if (isNaN(bt)) return -1;
    return bt - at;
  });
  return out;
}

/**
 * Pure. An exception rendered for a human, without inventing a cause.
 *
 * Every error message in this file used to name the most likely reason for a
 * failure instead of reporting the failure. That is worse than useless when the
 * guess is wrong: it sends the reader after the thing the message named, and
 * three of those in one day cost more than the original bugs did. A message may
 * state what was attempted and what came back. It may not state why.
 * @param {*} err
 * @return {string}
 */
function describeError_(err) {
  if (err == null) return '(no error object)';
  var name = err.name ? String(err.name) : '';
  var message = err.message ? String(err.message) : String(err);
  if (name && message.indexOf(name) !== 0) return name + ': ' + message;
  return message;
}

/**
 * Pure. Which account this code is running as, for an error message.
 *
 * Not a diagnosis — a fact. `getEffectiveUser` is the identity whose
 * authorization the Drive and Sheet calls actually use, and when it differs
 * from the signed-in user, or is blank, that is worth seeing next to a
 * permission failure rather than guessing at later.
 * @return {string}
 */
function identityNote_() {
  var active = '';
  var effective = '';
  try {
    active = String(Session.getActiveUser().getEmail() || '');
  } catch (err) {
    active = '(unavailable: ' + describeError_(err) + ')';
  }
  try {
    effective = String(Session.getEffectiveUser().getEmail() || '');
  } catch (err) {
    effective = '(unavailable: ' + describeError_(err) + ')';
  }
  return 'running as ' + (effective || '(blank)') + ', signed in as ' + (active || '(blank)');
}

/**
 * The Builds folder named by `builds_folder_id`.
 * @return {!Object} a Drive Folder
 */
function getBuildsFolder_() {
  var id = String(getSetting_('builds_folder_id', '')).trim();
  if (!id) {
    throw ksError_('SETTING_MISSING', 'The Settings key "builds_folder_id" is missing or empty.');
  }
  try {
    return DriveApp.getFolderById(id);
  } catch (err) {
    // Report the failure, do not diagnose it. The id is echoed because the
    // owner can compare it against the Sheet cell in one glance, and the
    // identity because a permission error means nothing without knowing which
    // account hit it. Everything else here is verbatim from Apps Script.
    throw ksError_(
      'DRIVE_FOLDER_FAILED',
      'DriveApp.getFolderById("' + id + '") threw. Apps Script said: ' + describeError_(err) +
        ' — ' + identityNote_() + '. This does not establish that the id is wrong; ' +
        'check the granted scopes and the account before changing the Settings cell.'
    );
  }
}

/**
 * The Trash subfolder of the Builds folder, created on first use.
 * @return {!Object} a Drive Folder
 */
function getTrashFolder_() {
  var parent = getBuildsFolder_();
  var found = parent.getFoldersByName(KS_TRASH_FOLDER);
  return found.hasNext() ? found.next() : parent.createFolder(KS_TRASH_FOLDER);
}

/**
 * Write one `<buildId>.ksb` of raw gzip bytes (SPEC §6.4).
 *
 * DriveApp cannot replace a file's binary content (setContent is text-only), so
 * a re-save trashes the previous file and creates a fresh one under the same
 * name. One live `.ksb` per build is the contract, decided by the owner on
 * ticket 003: the Drive advanced service is deliberately NOT pulled in to get a
 * true in-place binary update. Do not add it here.
 *
 * @param {string} buildId
 * @param {!Array<number>} bytes
 * @return {!Object} the Drive File
 */
function writeBuildFile_(buildId, bytes) {
  var folder = getBuildsFolder_();
  var name = String(buildId) + '.ksb';
  var existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  return folder.createFile(Utilities.newBlob(bytes, 'application/gzip', name));
}

/**
 * Read a build's gzip bytes back.
 * @param {string} driveFileId
 * @return {!Array<number>}
 */
function readBuildFile_(driveFileId) {
  var id = String(driveFileId == null ? '' : driveFileId).trim();
  if (!id) throw ksError_('BUILD_FILE_MISSING', 'This build has no Drive file recorded.');
  try {
    return DriveApp.getFileById(id).getBlob().getBytes();
  } catch (err) {
    throw ksError_(
      'BUILD_FILE_FAILED',
      'DriveApp.getFileById("' + id + '") threw. Apps Script said: ' + describeError_(err) +
        ' — ' + identityNote_() + '.'
    );
  }
}

/**
 * Move a build's Drive file into the Trash subfolder.
 * @param {string} driveFileId
 */
function moveBuildFileToTrash_(driveFileId) {
  var id = String(driveFileId == null ? '' : driveFileId).trim();
  if (!id) return;
  try {
    var file = DriveApp.getFileById(id);
    getTrashFolder_().addFile(file);
    getBuildsFolder_().removeFile(file);
  } catch (err) {
    console.error('moveBuildFileToTrash_("' + id + '") threw: ' + describeError_(err));
  }
}
