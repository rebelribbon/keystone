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
var KS_USERS_CACHE_KEY = 'ks_users';
var KS_SHEET_CACHE_TTL_SECONDS = 300;

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
  var cache = CacheService.getScriptCache();
  var hit = cache.get(KS_SETTINGS_CACHE_KEY);
  if (hit) {
    try {
      return JSON.parse(hit);
    } catch (err) {
      cache.remove(KS_SETTINGS_CACHE_KEY);
    }
  }
  var settings = parseSettingsRows_(readSheetRows_('Settings'));
  cache.put(KS_SETTINGS_CACHE_KEY, JSON.stringify(settings), KS_SHEET_CACHE_TTL_SECONDS);
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
  CacheService.getScriptCache().remove(KS_SETTINGS_CACHE_KEY);
}

/**
 * A user's role from the `Users` tab, or null when the account is not listed.
 * The rows are cached for 300 s, not the per-email answer.
 * @param {string} email
 * @return {?string}
 */
function getUserRole_(email) {
  var cache = CacheService.getScriptCache();
  var rows = null;
  var hit = cache.get(KS_USERS_CACHE_KEY);
  if (hit) {
    try {
      rows = JSON.parse(hit);
    } catch (err) {
      rows = null;
    }
  }
  if (!rows) {
    rows = readSheetRows_('Users');
    cache.put(KS_USERS_CACHE_KEY, JSON.stringify(rows), KS_SHEET_CACHE_TTL_SECONDS);
  }
  return findRole_(rows, email);
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
