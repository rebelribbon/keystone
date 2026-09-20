/**
 * Updater.gs — pull `dist/server/*` from a release tag, write it into this Apps
 * Script project, create a version, and repoint the test deployment
 * (SPEC §2.1 gate 6, §3.2; ADR 0002).
 *
 * Plain Apps Script V8: no imports, no bundling, no npm.
 *
 * Everything here is owner-only. The Builder cannot run Apps Script from a cloud
 * session, so every decision is factored into a pure helper with no Apps Script
 * global in its body — updaterEntryForPath_, mapServerEntries_,
 * manifestDigests_, mergeProjectFiles_, fingerprintDigests_, bytesToHex_,
 * backupFileName_, staleBackupNames_, releaseDatesByTag_, updaterApiHint_ —
 * and tests/server-logic.test.js evaluates this file as text and calls them.
 *
 * The bearer token from ScriptApp.getOAuthToken() carries `script.deployments`
 * now. It is used server-side only and is never put into a template, a payload
 * returned to the page, or a log row (ADR 0002, Consequences).
 */

var KS_SCRIPT_API_BASE = 'https://script.googleapis.com/v1/projects/';
var KS_UPDATER_TAG_CHOICES = 10;
var KS_BACKUP_PREFIX = 'server-backup-';
var KS_BACKUPS_KEPT = 10;

/** Settings keys the updater reads and writes. Spelled as ticket 004 names them. */
var KS_SETTING_TEST_DEPLOYMENT = 'testDeploymentId';
var KS_SETTING_STABLE_DEPLOYMENT = 'stableDeploymentId';
var KS_SETTING_SERVER_TAG = 'server_tag';
var KS_SETTING_SERVER_FINGERPRINT = 'server_fingerprint';

/**
 * dist extension → Apps Script API file type. The API's content model is
 * `{ name, type, source }` with the extension stripped from `name`, so the
 * mapping is derived here rather than written out per file: a server file added
 * in a later ticket needs no updater change.
 */
var KS_UPDATER_FILE_TYPES = { gs: 'SERVER_JS', html: 'HTML', json: 'JSON' };

/* -------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------- */

/**
 * Pure. One manifest `server` path as an Apps Script API entry.
 * @param {string} path e.g. `dist/server/Code.gs`
 * @return {{path: string, name: string, type: string}}
 */
function updaterEntryForPath_(path) {
  var full = String(path == null ? '' : path).trim();
  var base = full.split('/').pop();
  var dot = base.lastIndexOf('.');
  var name = dot > 0 ? base.slice(0, dot) : base;
  var ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  var type = KS_UPDATER_FILE_TYPES[ext];
  if (!name || !type) {
    throw ksError_(
      'UPDATER_UNKNOWN_FILE',
      'The release lists a server file this updater cannot classify: "' + full +
        '". Only .gs, .html and .json are supported. Nothing was written.'
    );
  }
  return { path: full, name: name, type: type };
}

/**
 * Pure. The manifest's `server` array as API entries.
 * An empty list aborts: writing an empty project would delete it.
 * @param {Array<string>} serverPaths
 * @return {!Array<{path: string, name: string, type: string}>}
 */
function mapServerEntries_(serverPaths) {
  var paths = serverPaths && serverPaths.length ? serverPaths : [];
  if (!paths.length) {
    throw ksError_(
      'UPDATER_NO_SERVER_FILES',
      'That release manifest lists no server files, so there is nothing to write. ' +
        'Pick a newer tag: the earliest build-* tags predate src/server/.'
    );
  }
  var out = [];
  for (var i = 0; i < paths.length; i++) out.push(updaterEntryForPath_(paths[i]));
  return out;
}

/**
 * Pure. `dist/...` path → sha256, from the manifest's `files` array.
 * @param {!Object} manifest
 * @return {!Object<string,string>}
 */
function manifestDigests_(manifest) {
  var out = {};
  var files = (manifest && manifest.files) || [];
  for (var i = 0; i < files.length; i++) {
    var entry = files[i] || {};
    var path = String(entry.path == null ? '' : entry.path).trim();
    if (!path) continue;
    out[path] = String(entry.sha256 == null ? '' : entry.sha256).trim().toLowerCase();
  }
  return out;
}

/**
 * Pure. Signed byte array → lowercase hex, for comparison against the manifest.
 * Utilities.computeDigest returns signed bytes, so -1 is 0xff.
 * @param {!Array<number>} bytes
 * @return {string}
 */
function bytesToHex_(bytes) {
  var list = bytes || [];
  var out = '';
  for (var i = 0; i < list.length; i++) {
    var value = list[i] & 255;
    out += (value < 16 ? '0' : '') + value.toString(16);
  }
  return out;
}

/**
 * Pure. Merge incoming files into the project's current content.
 *
 * `PUT .../content` replaces the *entire* project: any file absent from the
 * payload is deleted. So an entry the incoming set does not name is carried
 * through untouched, and a payload without `appsscript` is refused outright —
 * losing the manifest takes the scopes and the web app configuration with it.
 * @param {Array<Object>} existingFiles
 * @param {!Array<{name: string, type: string, source: string}>} incomingFiles
 * @return {!Array<Object>}
 */
function mergeProjectFiles_(existingFiles, incomingFiles) {
  var existing = existingFiles || [];
  var incoming = incomingFiles || [];

  var byName = {};
  for (var i = 0; i < incoming.length; i++) {
    byName[String(incoming[i].name)] = {
      name: String(incoming[i].name),
      type: String(incoming[i].type),
      source: String(incoming[i].source == null ? '' : incoming[i].source)
    };
  }

  var merged = [];
  var taken = {};
  for (var j = 0; j < existing.length; j++) {
    var current = existing[j] || {};
    var name = String(current.name == null ? '' : current.name);
    if (byName[name]) {
      merged.push(byName[name]);
      taken[name] = true;
    } else {
      merged.push({
        name: name,
        type: String(current.type == null ? '' : current.type),
        source: String(current.source == null ? '' : current.source)
      });
    }
  }
  for (var k = 0; k < incoming.length; k++) {
    var fresh = byName[String(incoming[k].name)];
    if (!taken[fresh.name]) merged.push(fresh);
  }

  var hasManifest = false;
  for (var m = 0; m < merged.length; m++) {
    if (merged[m].name === 'appsscript') hasManifest = true;
  }
  if (!hasManifest) {
    throw ksError_(
      'UPDATER_MANIFEST_MISSING',
      'Refusing to write: the payload would not contain "appsscript". A PUT ' +
        'replaces the whole project, so that would delete the manifest along ' +
        'with the OAuth scopes and the web app configuration. Nothing was written.'
    );
  }
  return merged;
}

/**
 * Pure. The fingerprint stored in Settings: the tag's server digests, in a
 * stable order, so `?dev=gates` can answer "what server code is running".
 * @param {!Array<{path: string}>} entries
 * @param {!Object<string,string>} digests
 * @return {string}
 */
function fingerprintDigests_(entries, digests) {
  var list = entries || [];
  var paths = [];
  for (var i = 0; i < list.length; i++) paths.push(String(list[i].path));
  paths.sort();
  var parts = [];
  for (var j = 0; j < paths.length; j++) {
    var name = paths[j].split('/').pop();
    var sha = String((digests || {})[paths[j]] || '');
    parts.push(name + ':' + sha.slice(0, 12));
  }
  return parts.join(' ');
}

/**
 * Pure. Backup file name. ISO with the punctuation dropped so Drive names sort
 * lexically in timestamp order, which is what staleBackupNames_ relies on.
 * @param {!Date} date
 * @return {string}
 */
function backupFileName_(date) {
  var iso = date.toISOString().replace(/[:.]/g, '-');
  return KS_BACKUP_PREFIX + iso + '.json';
}

/**
 * Pure. Which backup names to delete, keeping the `keep` newest.
 * @param {Array<string>} names
 * @param {number} keep
 * @return {!Array<string>}
 */
function staleBackupNames_(names, keep) {
  var limit = keep > 0 ? keep : 1;
  var matched = [];
  var list = names || [];
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i] == null ? '' : list[i]);
    if (name.indexOf(KS_BACKUP_PREFIX) === 0) matched.push(name);
  }
  matched.sort();
  matched.reverse();
  return matched.slice(limit);
}

/**
 * Pure. Release date per `build-*` tag, from a GitHub Releases payload.
 * Selection and ordering stay in pickNewestBuildTags_; this only supplies the
 * dates that go next to the tags in the picker.
 * @param {(string|Array<Object>)} releaseJson
 * @return {!Object<string,string>} tag → `published_at`, or ''
 */
function releaseDatesByTag_(releaseJson) {
  var releases = releaseJson;
  if (typeof releases === 'string') {
    try {
      releases = JSON.parse(releases);
    } catch (err) {
      return {};
    }
  }
  var out = {};
  if (!releases || typeof releases.length !== 'number') return out;
  for (var i = 0; i < releases.length; i++) {
    var release = releases[i] || {};
    var tag = String(release.tag_name == null ? '' : release.tag_name).trim();
    if (!tag) continue;
    var when = release.published_at || release.created_at || '';
    if (out[tag] === undefined) out[tag] = String(when == null ? '' : when);
  }
  return out;
}

/**
 * Pure. A labelled hypothesis for an Apps Script API status code.
 *
 * This is the one place in the server allowed to speculate, and only because
 * the caller prints the verbatim response first and prefixes this with
 * "Possible cause". A message that states a cause it did not verify is how an
 * hour gets spent on the wrong thing; a message that offers one, after the
 * facts and marked as a guess, is worth having.
 * @param {number} code
 * @return {string}
 */
function updaterApiHint_(code) {
  if (code === 403) {
    return 'Most likely the Apps Script API is switched off for this Google ' +
      'account: turn it on at https://script.google.com/home/usersettings and retry.';
  }
  if (code === 401) {
    return 'The authorization has expired or the script.deployments scope has ' +
      'not been granted yet. Reload the Sheet and re-authorize (ADR 0002).';
  }
  if (code === 404) {
    return 'The script id or deployment id was not found. Check ' +
      KS_SETTING_TEST_DEPLOYMENT + ' and ' + KS_SETTING_STABLE_DEPLOYMENT + ' in Settings.';
  }
  return '';
}

/* -------------------------------------------------------------------------
 * Apps Script API
 * ---------------------------------------------------------------------- */

/**
 * One Apps Script API call against this project. Never logs or returns the
 * bearer token.
 * @param {string} method 'get' | 'put' | 'post'
 * @param {string} path appended to `.../projects/{scriptId}`
 * @param {Object=} payload JSON body, omitted when undefined
 * @return {!Object}
 */
function scriptApiRequest_(method, path, payload) {
  var url = KS_SCRIPT_API_BASE + encodeURIComponent(ScriptApp.getScriptId()) + path;
  var options = {
    method: method,
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  };
  if (payload !== undefined && payload !== null) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var text = String(response.getContentText() || '');
  if (code < 200 || code >= 300) {
    // Verbatim first, hypothesis last and labelled as one.
    var hint = updaterApiHint_(code);
    throw ksError_(
      'UPDATER_API_FAILED',
      'The Apps Script API answered ' + code + ' for ' + method.toUpperCase() + ' ' + path +
        '. Response: ' + text.slice(0, 400) + (hint ? ' Possible cause: ' + hint : '')
    );
  }
  try {
    return JSON.parse(text || '{}');
  } catch (err) {
    throw ksError_('UPDATER_API_FAILED', 'The Apps Script API returned a body that is not JSON.');
  }
}

/** @return {!Object} the project's current `{ scriptId, files }`. */
function readProjectContent_() {
  return scriptApiRequest_('get', '/content');
}

/**
 * Replace the project's content.
 * @param {!Array<Object>} files
 * @return {!Object}
 */
function writeProjectContent_(files) {
  return scriptApiRequest_('put', '/content', { files: files });
}

/**
 * Create a new version of the project.
 * @param {string} description
 * @return {number} the new version number
 */
function createProjectVersion_(description) {
  var created = scriptApiRequest_('post', '/versions', { description: description });
  var number = Number(created && created.versionNumber);
  if (!number) {
    throw ksError_('UPDATER_API_FAILED', 'The Apps Script API created a version with no versionNumber.');
  }
  return number;
}

/**
 * Which version a deployment currently serves.
 * @param {string} deploymentId
 * @return {{versionNumber: number, description: string}}
 */
function readDeployment_(deploymentId) {
  var deployment = scriptApiRequest_('get', '/deployments/' + encodeURIComponent(deploymentId));
  var config = (deployment && deployment.deploymentConfig) || {};
  return {
    versionNumber: Number(config.versionNumber || 0),
    description: String(config.description == null ? '' : config.description)
  };
}

/**
 * Repoint a deployment at a version.
 * @param {string} deploymentId
 * @param {number} versionNumber
 * @param {string} description
 * @return {!Object}
 */
function setDeploymentVersion_(deploymentId, versionNumber, description) {
  return scriptApiRequest_('put', '/deployments/' + encodeURIComponent(deploymentId), {
    deploymentConfig: {
      scriptId: ScriptApp.getScriptId(),
      versionNumber: versionNumber,
      manifestFileName: 'appsscript',
      description: description
    }
  });
}

/* -------------------------------------------------------------------------
 * Fetch, verify, back up
 * ---------------------------------------------------------------------- */

/**
 * The GitHub Releases payload, uncached. The 60 s `ks_tags` cache holds two tag
 * names; the picker needs ten with their dates, and this runs only when the
 * owner opens the dialog.
 * @param {string} githubRepo
 * @return {string} the response body
 */
function updaterFetchReleases_(githubRepo) {
  var repo = String(githubRepo == null ? '' : githubRepo).trim();
  if (!repo) {
    throw ksError_('SETTING_MISSING', 'The Settings key "github_repo" is missing or empty.');
  }
  var response = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + encodeURI(repo) + '/releases?per_page=30',
    { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json' } }
  );
  if (response.getResponseCode() !== 200) {
    throw ksError_(
      'UPDATER_RELEASES_FAILED',
      'The GitHub Releases request for "' + repo + '" answered ' + response.getResponseCode() + '.'
    );
  }
  return String(response.getContentText() || '');
}

/**
 * Fetch one file and return its text plus the sha256 of its bytes.
 * @param {string} url
 * @return {{source: string, sha256: string}}
 */
function updaterFetchFile_(url) {
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw ksError_(
      'UPDATER_FETCH_FAILED',
      'Could not fetch ' + url + ' (HTTP ' + response.getResponseCode() + '). Nothing was written.'
    );
  }
  var bytes = response.getContent();
  return {
    source: String(response.getContentText() || ''),
    sha256: bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes))
  };
}

/**
 * Save the project's current content beside the builds, then prune to the ten
 * newest backups. Runs before every write (ADR 0002).
 * @param {!Object} content the `GET /content` response
 * @return {string} the backup file name
 */
function writeServerBackup_(content) {
  var folder = getBuildsFolder_();
  var name = backupFileName_(new Date());
  folder.createFile(name, JSON.stringify(content, null, 2), 'application/json');

  var names = [];
  var files = folder.getFiles();
  while (files.hasNext()) names.push(String(files.next().getName()));

  var stale = staleBackupNames_(names, KS_BACKUPS_KEPT);
  for (var i = 0; i < stale.length; i++) {
    var found = folder.getFilesByName(stale[i]);
    while (found.hasNext()) found.next().setTrashed(true);
  }
  return name;
}

/* -------------------------------------------------------------------------
 * Access
 * ---------------------------------------------------------------------- */

/**
 * The signed-in owner, or a throw. Every updater entry point goes through this
 * before it touches anything, so a non-owner gets a refusal and not a part-done
 * run (ticket 004, §2).
 * @return {{email: string, role: string}}
 */
function requireUpdaterOwner_() {
  var access = requireAccess_();
  if (!access.allowed) {
    // An unreadable Users tab is not a refusal (ticket 006): it carries its own
    // code so the dialog says "try again", not "you are not on the list".
    var refusal = accessError_(access);
    throw ksError_(refusal.code, refusal.message);
  }
  if (access.role !== 'owner') {
    throw ksError_('FORBIDDEN', 'Only the owner can update the server code.');
  }
  return access;
}

/**
 * Wrap an updater body with the owner gate and the `{ code, message }` contract
 * the dialogs expect. Mirrors apiCall_ rather than reusing it, because apiCall_
 * allows any listed role and these functions allow only the owner.
 * @param {function(!Object):*} body
 * @return {*}
 */
function updaterCall_(body) {
  var access;
  try {
    access = requireUpdaterOwner_();
  } catch (err) {
    return {
      code: (err && err.ksCode) || 'INTERNAL',
      message: err && err.message ? String(err.message) : String(err)
    };
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

/* -------------------------------------------------------------------------
 * The update run
 * ---------------------------------------------------------------------- */

/**
 * Fetch, verify, write, version, and repoint test — the whole of gate 6.
 *
 * Order matters: every file is fetched and digest-checked before the project is
 * read, and the project is backed up before it is written. A mismatch anywhere
 * aborts with nothing changed.
 * @param {string} tag a `build-N` tag
 * @param {!Object} access the resolved owner
 * @return {!Object} the completion summary
 */
function performServerUpdate_(tag, access) {
  var started = Date.now();
  var wanted = String(tag == null ? '' : tag).trim();
  if (!/^build-\d+$/.test(wanted)) {
    throw ksError_('BAD_REQUEST', 'Pick a build-* tag. Got "' + wanted + '".');
  }

  var settings = getSettings_();
  var base = buildBaseUrl_(settings['asset_base_url'], wanted);

  var manifest = JSON.parse(updaterFetchFile_(base + '/dist/manifest.json').source);
  var entries = mapServerEntries_(manifest.server);
  var digests = manifestDigests_(manifest);

  var incoming = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var expected = digests[entry.path];
    if (!expected) {
      throw ksError_(
        'UPDATER_DIGEST_MISSING',
        'The manifest lists "' + entry.path + '" under server but records no sha256 for it. Nothing was written.'
      );
    }
    var fetched = updaterFetchFile_(base + '/' + entry.path);
    if (fetched.sha256 !== expected) {
      throw ksError_(
        'UPDATER_DIGEST_MISMATCH',
        'Digest mismatch on "' + entry.path + '" at ' + wanted + ': the manifest says ' +
          expected.slice(0, 12) + '… and the fetched file is ' + fetched.sha256.slice(0, 12) +
          '…. Nothing was written. A partial or tampered server push is worse than a stale one.'
      );
    }
    incoming.push({ name: entry.name, type: entry.type, source: fetched.source });
  }

  var existing = readProjectContent_();
  var merged = mergeProjectFiles_(existing.files, incoming);
  var backup = writeServerBackup_(existing);
  writeProjectContent_(merged);

  var fingerprint = fingerprintDigests_(entries, digests);
  writeSetting_(KS_SETTING_SERVER_TAG, wanted);
  writeSetting_(KS_SETTING_SERVER_FINGERPRINT, fingerprint);

  var version = createProjectVersion_(wanted + ' via updater');

  var notes = [];
  var testDeploymentId = String(settings[KS_SETTING_TEST_DEPLOYMENT] || '').trim();
  var testRepointed = false;
  if (testDeploymentId) {
    setDeploymentVersion_(testDeploymentId, version, 'Keystone test — ' + wanted);
    testRepointed = true;
  } else {
    notes.push(
      'The test deployment was NOT repointed: the Settings key "' + KS_SETTING_TEST_DEPLOYMENT +
        '" is empty. Fill it from Deploy → Manage deployments and run this again — ' +
        'the files and version ' + version + ' are already in place.'
    );
  }
  if (!String(settings[KS_SETTING_STABLE_DEPLOYMENT] || '').trim()) {
    notes.push(
      'Promoting to stable will need the Settings key "' + KS_SETTING_STABLE_DEPLOYMENT + '", which is empty.'
    );
  }

  var elapsedMs = Date.now() - started;
  logRow_(
    access.email, 'server_update', '',
    wanted + ' version=' + version + ' test=' + (testRepointed ? 'repointed' : 'skipped') +
      ' files=' + incoming.length + ' backup=' + backup + ' ms=' + elapsedMs
  );

  return {
    ok: true,
    tag: wanted,
    version: version,
    fileCount: incoming.length,
    fingerprint: fingerprint,
    backup: backup,
    testRepointed: testRepointed,
    testUrl: withChannelParam_(String(settings['test_url'] || '').trim(), 'test'),
    stableUrl: String(settings['stable_url'] || '').trim(),
    elapsedMs: elapsedMs,
    notes: notes
  };
}

/**
 * Repoint the stable deployment at a version that is already on test.
 * Creates nothing: promotion only moves an existing version (ADR 0002 §3).
 * @param {number} expectedVersion the version the dialog showed the owner
 * @param {!Object} access
 * @return {!Object}
 */
function performStablePromotion_(expectedVersion, access) {
  var settings = getSettings_();
  var testDeploymentId = String(settings[KS_SETTING_TEST_DEPLOYMENT] || '').trim();
  var stableDeploymentId = String(settings[KS_SETTING_STABLE_DEPLOYMENT] || '').trim();
  if (!testDeploymentId) {
    throw ksError_('SETTING_MISSING', 'The Settings key "' + KS_SETTING_TEST_DEPLOYMENT + '" is empty.');
  }
  if (!stableDeploymentId) {
    throw ksError_('SETTING_MISSING', 'The Settings key "' + KS_SETTING_STABLE_DEPLOYMENT + '" is empty.');
  }

  var test = readDeployment_(testDeploymentId);
  if (!test.versionNumber) {
    throw ksError_('UPDATER_NO_VERSION', 'The test deployment serves no numbered version, so there is nothing to promote.');
  }
  var wanted = Number(expectedVersion);
  if (wanted && wanted !== test.versionNumber) {
    throw ksError_(
      'UPDATER_VERSION_MOVED',
      'The test deployment now serves version ' + test.versionNumber + ', not ' + wanted +
        ' as shown. Nothing was promoted — reopen the dialog and confirm against the current version.'
    );
  }

  var previous = readDeployment_(stableDeploymentId);
  var tag = String(settings[KS_SETTING_SERVER_TAG] || '').trim();
  setDeploymentVersion_(stableDeploymentId, test.versionNumber, 'Keystone stable — ' + (tag || 'promoted'));

  logRow_(
    access.email, 'server_promote', '',
    'version=' + test.versionNumber + ' from=' + previous.versionNumber + ' tag=' + tag
  );

  return {
    ok: true,
    version: test.versionNumber,
    previousVersion: previous.versionNumber,
    tag: tag,
    stableUrl: String(settings['stable_url'] || '').trim()
  };
}

/* -------------------------------------------------------------------------
 * Dialog-callable API (no trailing underscore: google.script.run cannot see
 * a name that ends in one — the same defect tickets 003 and 005 fixed)
 * ---------------------------------------------------------------------- */

/**
 * The newest ten `build-*` tags for the picker, with their release dates and a
 * marker on the tag the project currently runs.
 * @return {{tags: !Array<Object>, currentTag: string, fingerprint: string}|{code: string, message: string}}
 */
function ksUpdaterListTags() {
  return updaterCall_(function () {
    var settings = getSettings_();
    var body = updaterFetchReleases_(settings['github_repo']);
    var names = pickNewestBuildTags_(body, KS_UPDATER_TAG_CHOICES);
    var dates = releaseDatesByTag_(body);
    var currentTag = String(settings[KS_SETTING_SERVER_TAG] || '').trim();

    var tags = [];
    for (var i = 0; i < names.length; i++) {
      tags.push({
        tag: names[i],
        publishedAt: String(dates[names[i]] || ''),
        current: names[i] === currentTag
      });
    }
    return {
      tags: tags,
      currentTag: currentTag,
      fingerprint: String(settings[KS_SETTING_SERVER_FINGERPRINT] || '')
    };
  });
}

/**
 * Write one tag's server files, version, and repoint test.
 * @param {string} tag
 * @return {!Object}
 */
function ksUpdaterApplyTag(tag) {
  return updaterCall_(function (access) {
    return performServerUpdate_(tag, access);
  });
}

/**
 * What each deployment serves right now, for the promotion confirmation.
 * @return {!Object}
 */
function ksUpdaterDeploymentState() {
  return updaterCall_(function () {
    var settings = getSettings_();
    var testDeploymentId = String(settings[KS_SETTING_TEST_DEPLOYMENT] || '').trim();
    var stableDeploymentId = String(settings[KS_SETTING_STABLE_DEPLOYMENT] || '').trim();
    return {
      tag: String(settings[KS_SETTING_SERVER_TAG] || '').trim(),
      testVersion: testDeploymentId ? readDeployment_(testDeploymentId).versionNumber : 0,
      stableVersion: stableDeploymentId ? readDeployment_(stableDeploymentId).versionNumber : 0,
      testConfigured: !!testDeploymentId,
      stableConfigured: !!stableDeploymentId,
      missingKeys: (testDeploymentId ? [] : [KS_SETTING_TEST_DEPLOYMENT])
        .concat(stableDeploymentId ? [] : [KS_SETTING_STABLE_DEPLOYMENT])
    };
  });
}

/**
 * Promote the version already on test to stable.
 * @param {number} expectedVersion
 * @return {!Object}
 */
function ksUpdaterPromote(expectedVersion) {
  return updaterCall_(function (access) {
    return performStablePromotion_(expectedVersion, access);
  });
}

/* -------------------------------------------------------------------------
 * Menu and dialogs
 *
 * The dialog markup is an inline string rather than a seventh project file:
 * SPEC §3's server tree does not list one, and every extra file is another
 * paste in the owner's one-time bootstrap. The dialogs hold no state and no
 * secrets — they call the four ksUpdater* functions above and render what comes
 * back, and those functions re-check the owner on every call.
 * ---------------------------------------------------------------------- */

/** Pure. The shared dialog stylesheet, on the §13.1 identity tokens. */
function updaterDialogStyles_() {
  return [
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#27303A;',
    'margin:0;padding:18px;font-size:14px;line-height:1.5;background:#EEF1F0}',
    'h2{margin:0 0 10px;font-size:16px}',
    'p{margin:0 0 10px}',
    '.muted{color:#5c6672;font-size:13px}',
    '.err{color:#B4432F}',
    '.ok{color:#5E8B6A}',
    'ul{list-style:none;margin:0 0 12px;padding:0;max-height:240px;overflow:auto;',
    'background:#fff;border-radius:8px}',
    'li{padding:8px 10px;border-bottom:1px solid #e2e7e9}',
    'li:last-child{border-bottom:0}',
    'label{display:flex;gap:8px;align-items:baseline;cursor:pointer}',
    'code{font-variant-numeric:tabular-nums}',
    'button{font:inherit;padding:8px 14px;border-radius:6px;border:0;background:#0F7C8C;',
    'color:#fff;cursor:pointer}',
    'button[disabled]{opacity:0.5;cursor:default}',
    '.tag{font-weight:600}',
    '.badge{background:#C39A3E;color:#fff;border-radius:999px;padding:1px 7px;font-size:11px}',
    '</style>'
  ].join('');
}

/** Menu: *Update server code…* */
function ksMenuUpdateServerCode() {
  if (!updaterMenuGate_()) return;
  var html = [
    updaterDialogStyles_(),
    '<h2>Update server code</h2>',
    '<p class="muted">Pulls <code>dist/server/*</code> from the tag you pick, checks every file ',
    'against the release manifest, writes it into this project, creates a version, and points the ',
    '<strong>test</strong> deployment at it. Stable keeps serving its current version until you promote it.</p>',
    '<div id="host"><p class="muted">Loading releases…</p></div>',
    '<script>',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){',
    'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    'function fail(m){document.getElementById("host").innerHTML="<p class=\\"err\\">"+esc(m)+"</p>";}',
    'function when(v){if(!v)return"";var d=new Date(v);return isNaN(d)?v:d.toISOString().slice(0,10);}',
    'function list(res){',
    ' if(res&&res.code){return fail(res.message);}',
    ' if(!res.tags.length){return fail("No build-* release was found.");}',
    ' var out="<ul>";',
    ' res.tags.forEach(function(t,i){',
    '  out+="<li><label><input type=\\"radio\\" name=\\"tag\\" value=\\""+esc(t.tag)+"\\""+(i===0?" checked":"")+">";',
    '  out+="<span><span class=\\"tag\\">"+esc(t.tag)+"</span> <span class=\\"muted\\">"+esc(when(t.publishedAt))+"</span> ";',
    '  out+=(t.current?"<span class=\\"badge\\">running now</span>":"")+"</span></label></li>";',
    ' });',
    ' out+="</ul><button id=\\"go\\">Write to this project</button>";',
    ' if(res.fingerprint){out+="<p class=\\"muted\\">Current fingerprint: "+esc(res.fingerprint)+"</p>";}',
    ' document.getElementById("host").innerHTML=out;',
    ' document.getElementById("go").onclick=apply;',
    '}',
    'function apply(){',
    ' var picked=document.querySelector("input[name=tag]:checked");',
    ' if(!picked)return;',
    ' document.getElementById("go").disabled=true;',
    ' document.getElementById("host").innerHTML="<p class=\\"muted\\">Fetching, verifying and writing "+esc(picked.value)+"… this takes a few seconds.</p>";',
    ' google.script.run.withSuccessHandler(done).withFailureHandler(function(e){fail(e.message||e);})',
    '  .ksUpdaterApplyTag(picked.value);',
    '}',
    'function done(res){',
    ' if(res&&res.code){return fail(res.message);}',
    ' var out="<p class=\\"ok\\"><strong>Wrote "+esc(res.tag)+"</strong> — "+res.fileCount+" files, version "+res.version+" created in "+Math.round(res.elapsedMs/100)/10+" s.</p>";',
    ' out+="<p>The <strong>test</strong> deployment "+(res.testRepointed?"now serves version "+res.version:"was not repointed")+".";',
    ' out+=" <strong>Stable</strong> still serves its previous version until you run <em>Promote server code to stable</em>.</p>";',
    ' if(res.testUrl){out+="<p>Test: <a href=\\""+esc(res.testUrl)+"\\" target=\\"_blank\\" rel=\\"noopener\\">"+esc(res.testUrl)+"</a></p>";}',
    ' if(res.stableUrl){out+="<p>Stable: <a href=\\""+esc(res.stableUrl)+"\\" target=\\"_blank\\" rel=\\"noopener\\">"+esc(res.stableUrl)+"</a></p>";}',
    ' out+="<p class=\\"muted\\">Backup: "+esc(res.backup)+" in the Builds folder. Fingerprint: "+esc(res.fingerprint)+"</p>";',
    ' (res.notes||[]).forEach(function(n){out+="<p class=\\"err\\">"+esc(n)+"</p>";});',
    ' document.getElementById("host").innerHTML=out;',
    '}',
    'google.script.run.withSuccessHandler(list).withFailureHandler(function(e){fail(e.message||e);})',
    ' .ksUpdaterListTags();',
    '</script>'
  ].join('');

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(620).setHeight(520),
    'Keystone — update server code'
  );
}

/** Menu: *Promote server code to stable…* */
function ksMenuPromoteServerToStable() {
  if (!updaterMenuGate_()) return;
  var html = [
    updaterDialogStyles_(),
    '<h2>Promote server code to stable</h2>',
    '<p class="muted">This moves the version already on <strong>test</strong> onto ',
    '<strong>stable</strong>. It creates nothing. Test the test URL first.</p>',
    '<div id="host"><p class="muted">Reading both deployments…</p></div>',
    '<script>',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){',
    'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    'function fail(m){document.getElementById("host").innerHTML="<p class=\\"err\\">"+esc(m)+"</p>";}',
    'var state=null;',
    'function show(res){',
    ' if(res&&res.code){return fail(res.message);}',
    ' state=res;',
    ' if(res.missingKeys.length){return fail("Fill these Settings keys first: "+esc(res.missingKeys.join(", "))+".");}',
    ' if(!res.testVersion){return fail("The test deployment serves no numbered version yet. Run Update server code first.");}',
    ' var out="<p>Test serves version <strong>"+res.testVersion+"</strong>";',
    ' out+=res.tag?" (tag "+esc(res.tag)+")":"";',
    ' out+=". Stable serves version <strong>"+(res.stableVersion||"—")+"</strong>.</p>";',
    ' if(res.testVersion===res.stableVersion){out+="<p class=\\"ok\\">Stable already serves this version. Nothing to do.</p>";',
    '  document.getElementById("host").innerHTML=out;return;}',
    ' out+="<p>Point <strong>stable</strong> at version "+res.testVersion+(res.tag?" ("+esc(res.tag)+")":"")+"?</p>";',
    ' out+="<button id=\\"go\\">Yes, promote version "+res.testVersion+"</button>";',
    ' document.getElementById("host").innerHTML=out;',
    ' document.getElementById("go").onclick=promote;',
    '}',
    'function promote(){',
    ' document.getElementById("go").disabled=true;',
    ' google.script.run.withSuccessHandler(done).withFailureHandler(function(e){fail(e.message||e);})',
    '  .ksUpdaterPromote(state.testVersion);',
    '}',
    'function done(res){',
    ' if(res&&res.code){return fail(res.message);}',
    ' var out="<p class=\\"ok\\"><strong>Stable now serves version "+res.version+"</strong>";',
    ' out+=res.tag?" (tag "+esc(res.tag)+")":"";',
    ' out+=", up from version "+(res.previousVersion||"—")+".</p>";',
    ' if(res.stableUrl){out+="<p>Stable: <a href=\\""+esc(res.stableUrl)+"\\" target=\\"_blank\\" rel=\\"noopener\\">"+esc(res.stableUrl)+"</a></p>";}',
    ' document.getElementById("host").innerHTML=out;',
    '}',
    'google.script.run.withSuccessHandler(show).withFailureHandler(function(e){fail(e.message||e);})',
    ' .ksUpdaterDeploymentState();',
    '</script>'
  ].join('');

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(360),
    'Keystone — promote to stable'
  );
}

/**
 * Owner check for the two menu items. A non-owner gets one line, not a stack
 * trace, and no dialog opens.
 * @return {boolean} true when the caller may proceed
 */
function updaterMenuGate_() {
  try {
    requireUpdaterOwner_();
    return true;
  } catch (err) {
    try {
      SpreadsheetApp.getActive().toast('Keystone: owner only.', 'Keystone', 5);
    } catch (toastErr) {
      console.error('updaterMenuGate_ toast failed: ' + toastErr);
    }
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Access diagnostics
 *
 * Added after the third failure in one day whose message named a plausible but
 * wrong cause. Every check here reports what happened, verbatim; none of them
 * concludes anything. The point is to make the next "why can't it reach X"
 * answerable in one click instead of three hypotheses.
 * ---------------------------------------------------------------------- */

/**
 * Pure. The scope list from a tokeninfo response body.
 * @param {string} body
 * @return {!Array<string>} short scope names, sorted
 */
function parseGrantedScopes_(body) {
  var parsed;
  try {
    parsed = JSON.parse(String(body == null ? '' : body));
  } catch (err) {
    return [];
  }
  var raw = String((parsed && parsed.scope) || '').trim();
  if (!raw) return [];
  var out = raw.split(/\s+/).map(function (scope) {
    return scope.replace('https://www.googleapis.com/auth/', '');
  });
  out.sort();
  return out;
}

/**
 * Which OAuth scopes this execution's token actually carries.
 *
 * The manifest says what was *requested*. Google's consent screen decides what
 * was *granted*, and on an unverified app a user can grant a subset — so the two
 * lists can differ, silently, and only this endpoint knows which. The token goes
 * to Google's own tokeninfo endpoint and nowhere else; only the scope list comes
 * back out of this function.
 * @return {{scopes: !Array<string>, error: string}}
 */
function grantedScopes_() {
  try {
    var response = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' +
        encodeURIComponent(ScriptApp.getOAuthToken()),
      { muteHttpExceptions: true }
    );
    if (response.getResponseCode() !== 200) {
      return { scopes: [], error: 'tokeninfo answered ' + response.getResponseCode() };
    }
    return { scopes: parseGrantedScopes_(response.getContentText()), error: '' };
  } catch (err) {
    return { scopes: [], error: describeError_(err) };
  }
}

/**
 * Run one probe and record the outcome without interpreting it.
 * @param {string} label
 * @param {function():string} probe returns a short description of what it got
 * @return {{label: string, ok: boolean, detail: string}}
 */
function runProbe_(label, probe) {
  try {
    return { label: label, ok: true, detail: probe() };
  } catch (err) {
    return { label: label, ok: false, detail: describeError_(err) };
  }
}

/**
 * Owner-only. Report identity, granted scopes, and the result of each Apps
 * Script call the server depends on. Reports; does not diagnose.
 * @return {!Object}
 */
function ksUpdaterDiagnoseAccess() {
  return updaterCall_(function () {
    var granted = grantedScopes_();
    var folderId = '';
    try {
      folderId = String(getSetting_('builds_folder_id', '')).trim();
    } catch (err) {
      folderId = '';
    }

    var probes = [
      runProbe_('Sheet read (Settings tab)', function () {
        return Object.keys(getSettings_()).length + ' keys';
      }),
      runProbe_('Drive at all — DriveApp.getRootFolder()', function () {
        return 'opened "' + DriveApp.getRootFolder().getName() + '"';
      }),
      runProbe_('Builds folder — getFolderById(' + (folderId || 'unset') + ')', function () {
        if (!folderId) throw new Error('builds_folder_id is unset in Settings');
        var folder = DriveApp.getFolderById(folderId);
        return 'opened "' + folder.getName() + '"';
      }),
      runProbe_('Apps Script API — GET /content', function () {
        return (readProjectContent_().files || []).length + ' project files';
      }),
      runProbe_('External fetch — GitHub Releases', function () {
        return updaterFetchReleases_(getSetting_('github_repo', '')).length + ' bytes';
      })
    ];

    return {
      identity: identityNote_(),
      scriptId: ScriptApp.getScriptId(),
      grantedScopes: granted.scopes,
      grantedScopesError: granted.error,
      probes: probes
    };
  });
}

/** Menu: *Diagnose access…* */
function ksMenuDiagnoseAccess() {
  if (!updaterMenuGate_()) return;
  var html = [
    updaterDialogStyles_(),
    '<h2>Diagnose access</h2>',
    '<p class="muted">What this execution can actually reach, and which OAuth scopes ',
    'Google really granted — which is not always what the manifest asked for. ',
    'Every line is a measurement; none of them is a conclusion.</p>',
    '<div id="host"><p class="muted">Running probes…</p></div>',
    '<script>',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){',
    'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    'function fail(m){document.getElementById("host").innerHTML="<p class=\\"err\\">"+esc(m)+"</p>";}',
    'function show(res){',
    ' if(res&&res.code){return fail(res.message);}',
    ' var out="<p>"+esc(res.identity)+"</p>";',
    ' out+="<p class=\\"muted\\">script id "+esc(res.scriptId)+"</p>";',
    ' out+="<p><strong>Granted scopes</strong> ("+res.grantedScopes.length+")";',
    ' out+=res.grantedScopesError?" <span class=\\"err\\">"+esc(res.grantedScopesError)+"</span>":"";',
    ' out+="</p><ul>";',
    ' res.grantedScopes.forEach(function(s){out+="<li>"+esc(s)+"</li>";});',
    ' if(!res.grantedScopes.length){out+="<li class=\\"err\\">none reported</li>";}',
    ' out+="</ul><p><strong>Probes</strong></p><ul>";',
    ' res.probes.forEach(function(p){',
    '  out+="<li><span class=\\""+(p.ok?"ok":"err")+"\\">"+(p.ok?"OK":"FAILED")+"</span> ";',
    '  out+=esc(p.label)+" — "+esc(p.detail)+"</li>";',
    ' });',
    ' out+="</ul>";',
    ' document.getElementById("host").innerHTML=out;',
    '}',
    'google.script.run.withSuccessHandler(show).withFailureHandler(function(e){fail(e.message||e);})',
    ' .ksUpdaterDiagnoseAccess();',
    '</script>'
  ].join('');

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(640).setHeight(560),
    'Keystone — diagnose access'
  );
}
