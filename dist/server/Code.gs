/**
 * Code.gs — web app loader, access check, and Sheet menu (SPEC §2.2, §3.1, §14.2).
 *
 * Plain Apps Script V8: no imports, no bundling, no npm.
 *
 * The Builder cannot deploy or run Apps Script from a cloud session, so every
 * decision this file makes is factored into a pure helper with no Apps Script
 * globals in its body: pickNewestBuildTags_, buildBaseUrl_, resolveChannel_,
 * decideAccess_, applyTagOverride_, withChannelParam_, splitChunks_,
 * escapeHtml_, toSafeJson_. tests/server-logic.test.js evaluates this file as
 * text and calls them directly.
 */

var KS_DEFAULT_ASSET_BASE_URL = 'https://cdn.jsdelivr.net/gh/rebelribbon/keystone@{tag}';
var KS_TAGS_CACHE_KEY = 'ks_tags';
var KS_TAGS_CACHE_TTL_SECONDS = 60;
var KS_BUNDLE_CACHE_TTL_SECONDS = 21600;
var KS_BUNDLE_CHUNK_CHARS = 90000;
var KS_FIRST_RENDER_BUDGET_MS = 6000;

/** Client bundles, in the §3.1 load order. */
var KS_CLIENT_BUNDLES = [
  'vendor-three.js',
  'engine.js',
  'catalog-materials.js',
  'catalog-styles.js',
  'catalog-exterior.js',
  'catalog-interior.js'
];

/* -------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------- */

/**
 * Pure. Newest `build-N` tags, newest first, from a GitHub Releases payload
 * (array or JSON text). Tag names that are not `build-<digits>` are ignored.
 * Sorted by the numeric suffix, not lexically, so build-12 > build-9.
 *
 * `limit` defaults to 2, which is what the loader needs (the tag it serves plus
 * the one behind it for "Try the previous build"). Ticket 004's tag picker asks
 * for ten through the same function rather than keeping a second copy of this.
 * @param {(string|Array<Object>)} releaseJson
 * @param {number=} limit how many tags to return, default 2
 * @return {!Array<string>} zero or more tag names, at most `limit`
 */
function pickNewestBuildTags_(releaseJson, limit) {
  var releases = releaseJson;
  if (typeof releases === 'string') {
    try {
      releases = JSON.parse(releases);
    } catch (err) {
      return [];
    }
  }
  if (!releases || typeof releases.length !== 'number' || !releases.length) return [];

  var matched = [];
  for (var i = 0; i < releases.length; i++) {
    var release = releases[i] || {};
    var name = String(release.tag_name == null ? '' : release.tag_name).trim();
    var match = /^build-(\d+)$/.exec(name);
    if (!match) continue;
    matched.push({ tag: name, number: parseInt(match[1], 10) });
  }
  matched.sort(function (a, b) { return b.number - a.number; });

  var want = limit === undefined || limit === null ? 2 : Math.floor(Number(limit));
  if (!(want > 0)) want = 2;

  var tags = [];
  for (var j = 0; j < matched.length && tags.length < want; j++) {
    if (tags.indexOf(matched[j].tag) === -1) tags.push(matched[j].tag);
  }
  return tags;
}

/**
 * Pure. Resolve `asset_base_url` for a tag: substitute `{tag}`, strip any
 * trailing slash. Falls back to the jsDelivr default when the setting is blank.
 * @param {string} assetBaseUrl
 * @param {string} tag
 * @return {string}
 */
function buildBaseUrl_(assetBaseUrl, tag) {
  var template = String(assetBaseUrl == null ? '' : assetBaseUrl).trim();
  if (!template) template = KS_DEFAULT_ASSET_BASE_URL;
  var resolved = template.replace(/\{tag\}/g, String(tag == null ? '' : tag).trim());
  return resolved.replace(/\/+$/, '');
}

/**
 * Pure. The channel comes from an explicit `?c=` parameter (ADR 0001).
 *
 * The /dev URL is no longer part of the deployment model: Google rewrites the
 * path to /macros/u/N/s/... when the caller is signed into several accounts and
 * the request never reaches doGet, so service-URL inspection cannot be relied
 * on. `?c=` is not owner-restricted — it selects only which public jsDelivr
 * bundle the page loads, and both bundles are public artifacts of a public repo.
 * @param {Object} params the query parameters
 * @return {string} 'test' | 'stable'
 */
function resolveChannel_(params) {
  var source = params || {};
  var requested = String(source.c == null ? '' : source.c).trim().toLowerCase();
  return requested === 'test' ? 'test' : 'stable';
}

/**
 * Pure. The authorize/deny decision. An empty email (Apps Script could not
 * resolve the account) and an email with no `Users` row are both denied.
 * @param {string} email
 * @param {?string} role
 * @return {{allowed: boolean, email: string, role: ?string, code: ?string, reason: string}}
 */
function decideAccess_(email, role) {
  var normalized = String(email == null ? '' : email).trim().toLowerCase();
  if (!normalized) {
    return { allowed: false, email: '', role: null, code: 'ACCESS_DENIED', reason: 'no_email' };
  }
  var normalizedRole = String(role == null ? '' : role).trim().toLowerCase();
  if (KS_VALID_ROLES.indexOf(normalizedRole) === -1) {
    return { allowed: false, email: normalized, role: null, code: 'ACCESS_DENIED', reason: 'not_listed' };
  }
  return { allowed: true, email: normalized, role: normalizedRole, code: null, reason: 'ok' };
}

/**
 * Pure. Apply an owner-only `?tag=` override to a resolved release.
 * Non-owners and malformed tags are ignored silently.
 * @param {!Object} release
 * @param {string} paramTag
 * @param {?string} role
 * @return {!Object}
 */
function applyTagOverride_(release, paramTag, role) {
  if (role !== 'owner') return release;
  var requested = String(paramTag == null ? '' : paramTag).trim();
  if (!/^build-\d+$/.test(requested)) return release;
  return {
    tag: requested,
    previousTag: release.previousTag === requested ? '' : release.previousTag,
    degraded: release.degraded,
    degradedReason: release.degradedReason,
    error: ''
  };
}

/**
 * Pure. Append the channel parameter to a deployment URL (ADR 0001).
 * The stable channel is the default, so it carries no parameter.
 * @param {string} url
 * @param {string} channel
 * @return {string}
 */
function withChannelParam_(url, channel) {
  var base = String(url == null ? '' : url).trim();
  if (!base || channel !== 'test') return base;
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'c=test';
}

/**
 * Pure. Split a string into fixed-size pieces.
 * @param {string} text
 * @param {number} size
 * @return {!Array<string>}
 */
function splitChunks_(text, size) {
  var value = String(text == null ? '' : text);
  var step = size > 0 ? size : 1;
  var out = [];
  for (var i = 0; i < value.length; i += step) out.push(value.substr(i, step));
  return out;
}

/**
 * Pure. Escape a value for HTML text and attribute contexts.
 * @param {*} value
 * @return {string}
 */
function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pure. JSON for embedding inside a <script> block. Escapes the characters
 * that could end the element or break a JS parse, so no settings or user value
 * is ever concatenated raw into the page.
 * @param {*} value
 * @return {string}
 */
function toSafeJson_(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/* -------------------------------------------------------------------------
 * Tag resolution
 * ---------------------------------------------------------------------- */

/**
 * Newest two `build-*` tags from the GitHub Releases API, cached 60 s.
 * Returns [] on any failure; the caller decides how to degrade.
 * @param {string} githubRepo
 * @return {!Array<string>}
 */
function fetchBuildTags_(githubRepo) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(KS_TAGS_CACHE_KEY);
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      if (cached && cached.length) return cached;
    } catch (err) {
      cache.remove(KS_TAGS_CACHE_KEY);
    }
  }

  var repo = String(githubRepo == null ? '' : githubRepo).trim();
  if (!repo) return [];

  var response = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + encodeURI(repo) + '/releases?per_page=30',
    { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json' } }
  );
  if (response.getResponseCode() !== 200) return [];

  var tags = pickNewestBuildTags_(response.getContentText());
  if (tags.length) cache.put(KS_TAGS_CACHE_KEY, JSON.stringify(tags), KS_TAGS_CACHE_TTL_SECONDS);
  return tags;
}

/**
 * Resolve which tag to serve for a channel.
 * `stable` reads `stable_tag`. `test` asks GitHub for the newest `build-*` and
 * falls back to `stable_tag` with a degraded flag when that fails. `error` is
 * set only when nothing safe is left to load, so the caller never renders a
 * page pointing at a broken URL.
 * @param {string} channel
 * @param {!Object<string,string>} settings
 * @return {{tag: string, previousTag: string, degraded: boolean, degradedReason: string, error: string}}
 */
function resolveRelease_(channel, settings) {
  var config = settings || {};
  var stableTag = String(config['stable_tag'] == null ? '' : config['stable_tag']).trim();

  if (channel === 'stable') {
    if (!stableTag) {
      return {
        tag: '', previousTag: '', degraded: false, degradedReason: '',
        error: 'The Settings key "stable_tag" is missing or empty, so the stable deployment has nothing to load.'
      };
    }
    return { tag: stableTag, previousTag: '', degraded: false, degradedReason: '', error: '' };
  }

  var tags = [];
  var reason = '';
  try {
    tags = fetchBuildTags_(config['github_repo']);
    if (!tags.length) {
      reason = 'No build-* release was found for "' + (config['github_repo'] || '(github_repo is unset)') + '".';
    }
  } catch (err) {
    reason = 'The GitHub Releases request failed: ' + err + '.';
  }

  if (tags.length) {
    return { tag: tags[0], previousTag: tags.length > 1 ? tags[1] : '', degraded: false, degradedReason: '', error: '' };
  }
  if (!stableTag) {
    return {
      tag: '', previousTag: '', degraded: true, degradedReason: reason,
      error: reason + ' The Settings key "stable_tag" is also missing or empty, so there is no tag to fall back to.'
    };
  }
  return {
    tag: stableTag, previousTag: '', degraded: true,
    degradedReason: reason + ' Falling back to stable_tag (' + stableTag + ').',
    error: ''
  };
}

/* -------------------------------------------------------------------------
 * Web app
 * ---------------------------------------------------------------------- */

/** @return {string} the signed-in email, or '' when Apps Script cannot resolve one. */
function activeEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim();
  } catch (err) {
    return '';
  }
}

/**
 * Web app entry point (SPEC §3.1).
 * @param {Object} e
 * @return {!HtmlOutput}
 */
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};

  var email = activeEmail_();
  var role = null;
  try {
    role = getUserRole_(email);
  } catch (err) {
    role = null;
  }

  var access = decideAccess_(email, role);
  if (!access.allowed) {
    logRow_(access.email, 'access_denied', '', 'reason=' + access.reason);
    return renderAccessScreen_(access.email);
  }

  var settings = {};
  try {
    settings = getSettings_();
  } catch (err) {
    return renderErrorScreen_('Keystone could not read the Settings tab: ' + err);
  }

  var devGates = params.dev === 'gates' && access.role === 'owner';
  var channel = resolveChannel_(params);
  var release = applyTagOverride_(resolveRelease_(channel, settings), params.tag, access.role);
  if (release.error) return renderErrorScreen_(release.error);

  var base = buildBaseUrl_(settings['asset_base_url'], release.tag);
  var loaderMode = String(settings['loader_mode'] || 'cdn').trim().toLowerCase() === 'inline' ? 'inline' : 'cdn';

  var template = HtmlService.createTemplateFromFile('Index');
  template.bootJson = toSafeJson_({
    tag: release.tag,
    previousTag: release.previousTag,
    channel: channel,
    user: access.email,
    role: access.role,
    base: base,
    degraded: !!release.degraded,
    degradedReason: release.degradedReason,
    loaderMode: loaderMode,
    devGates: devGates,
    // Ticket 004 writes these after every server update, so ?dev=gates always
    // has an answer to "what server code is actually running". Owner-only and
    // gates-only: it is a build tag and six truncated digests of public files,
    // but no page needs it to boot.
    serverTag: devGates ? String(settings[KS_SETTING_SERVER_TAG] || '') : '',
    serverFingerprint: devGates ? String(settings[KS_SETTING_SERVER_FINGERPRINT] || '') : '',
    devGate3: params.dev === 'gate3' && access.role === 'owner',
    gate3Evict: params.evict === undefined || params.evict === '' ? null : Number(params.evict),
    gate3Cold: params.cold === '1',
    bundles: KS_CLIENT_BUNDLES,
    firstRenderBudgetMs: KS_FIRST_RENDER_BUDGET_MS
  });
  template.base = base;
  template.loaderMode = loaderMode;
  template.devGates = devGates;
  template.devGate3 = params.dev === 'gate3' && access.role === 'owner';
  template.inlineStyles = loaderMode === 'inline' ? getInlineAsset_(base, 'styles.css') : '';
  template.inlineBundles = loaderMode === 'inline' ? inlineBundleSources_(release.tag, base) : [];

  return template.evaluate()
    .setTitle('Keystone')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Include one project file's contents into a template.
 * @param {string} filename
 * @return {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* -------------------------------------------------------------------------
 * Gate 1 fallback: server-side bundle fetch (loader_mode = inline)
 * ---------------------------------------------------------------------- */

/**
 * @param {string} tag
 * @param {string} file
 * @param {(number|string)} index
 * @return {string}
 */
function bundleCacheKey_(tag, file, index) {
  return 'ks_bundle_' + tag + '_' + file + '_' + index;
}

/**
 * Fetch one client bundle server-side, base64-encode it, and chunk it into
 * CacheService (6 h TTL) so it survives the per-key size cap. Returns the
 * chunks. This is the §2.1 gate 1 fallback, reached only when the Settings key
 * `loader_mode` is `inline`.
 *
 * The name carries no trailing underscore on purpose: Apps Script will not
 * expose `name_` to google.script.run, which made the client-callable path this
 * function is meant to serve unreachable as shipped in ticket 002.
 * @param {string} tag
 * @param {string} file
 * @return {{ok: boolean, tag: string, file: string, total: number, chunks: !Array<string>}|{code: string, message: string}}
 */
function api_getBundle(tag, file) {
  // Making this callable by google.script.run also makes it reachable by any
  // signed-in Google account, so it needs the same gate as the rest of the API
  // and its two arguments must not be able to steer the fetch anywhere else.
  var access = decideAccess_(activeEmail_(), (function () {
    try { return getUserRole_(activeEmail_()); } catch (err) { return null; }
  })());
  if (!access.allowed) {
    return { code: 'ACCESS_DENIED', message: 'This Google account is not on the Keystone access list.' };
  }
  if (!/^build-\d+$/.test(String(tag == null ? '' : tag).trim())) {
    return { code: 'BAD_REQUEST', message: 'tag must be a build-<number> release tag.' };
  }
  if (KS_CLIENT_BUNDLES.indexOf(String(file == null ? '' : file)) === -1) {
    return { code: 'BAD_REQUEST', message: 'file must be one of the published client bundles.' };
  }

  var cache = CacheService.getScriptCache();
  var countKey = bundleCacheKey_(tag, file, 'count');
  var countHit = cache.get(countKey);

  if (countHit) {
    var total = parseInt(countHit, 10);
    var keys = [];
    for (var i = 0; i < total; i++) keys.push(bundleCacheKey_(tag, file, i));
    var found = cache.getAll(keys) || {};
    var cachedChunks = [];
    var complete = true;
    for (var j = 0; j < total; j++) {
      var piece = found[bundleCacheKey_(tag, file, j)];
      if (piece == null) { complete = false; break; }
      cachedChunks.push(piece);
    }
    if (complete) return { ok: true, tag: tag, file: file, total: total, chunks: cachedChunks };
  }

  var base = buildBaseUrl_(getSetting_('asset_base_url', KS_DEFAULT_ASSET_BASE_URL), tag);
  var url = base + '/dist/client/' + file;
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    return {
      code: 'BUNDLE_FETCH_FAILED',
      message: 'Could not fetch ' + file + ' at ' + tag + ' (HTTP ' + response.getResponseCode() + ').'
    };
  }

  var encoded = Utilities.base64Encode(response.getContent());
  var chunks = splitChunks_(encoded, KS_BUNDLE_CHUNK_CHARS);
  var writes = {};
  for (var k = 0; k < chunks.length; k++) writes[bundleCacheKey_(tag, file, k)] = chunks[k];
  cache.putAll(writes, KS_BUNDLE_CACHE_TTL_SECONDS);
  cache.put(countKey, String(chunks.length), KS_BUNDLE_CACHE_TTL_SECONDS);

  return { ok: true, tag: tag, file: file, total: chunks.length, chunks: chunks };
}

/**
 * One bundle's source text, assembled from api_getBundle_ chunks.
 * @param {string} tag
 * @param {string} file
 * @return {string}
 */
function getBundleSource_(tag, file) {
  var result = api_getBundle(tag, file);
  if (!result || !result.ok) {
    throw new Error(result && result.message ? result.message : 'Could not fetch ' + file + '.');
  }
  return Utilities.newBlob(Utilities.base64Decode(result.chunks.join(''))).getDataAsString();
}

/**
 * Every client bundle's source, in §3.1 order, for inline mode.
 * @param {string} tag
 * @param {string} base
 * @return {!Array<{file: string, source: string}>}
 */
function inlineBundleSources_(tag, base) {
  var out = [];
  for (var i = 0; i < KS_CLIENT_BUNDLES.length; i++) {
    out.push({ file: KS_CLIENT_BUNDLES[i], source: getBundleSource_(tag, KS_CLIENT_BUNDLES[i]) });
  }
  return out;
}

/**
 * A non-bundle asset (styles.css) fetched server-side for inline mode.
 * @param {string} base
 * @param {string} file
 * @return {string}
 */
function getInlineAsset_(base, file) {
  var response = UrlFetchApp.fetch(base + '/dist/client/' + file, { muteHttpExceptions: true });
  return response.getResponseCode() === 200 ? response.getContentText() : '';
}

/* -------------------------------------------------------------------------
 * Standalone screens
 * ---------------------------------------------------------------------- */

/**
 * Shared shell for the self-contained screens: no external scripts, no
 * jsDelivr dependency, inline CSS using the §13.1 token values.
 * @param {string} heading
 * @param {string} bodyHtml
 * @return {!HtmlOutput}
 */
function renderStandaloneScreen_(heading, bodyHtml) {
  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Keystone</title><style>',
    ':root{--survey:#0F7C8C;--graphite:#27303A;--mortar:#EEF1F0;--limewash:#FFFFFF;--brick:#B4432F}',
    '*,*::before,*::after{box-sizing:border-box}',
    'html,body{margin:0;padding:0;height:100%}',
    'body{display:flex;align-items:center;justify-content:center;background:var(--mortar);',
    'color:var(--graphite);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}',
    '.card{max-width:520px;background:var(--limewash);border-radius:14px;padding:28px 32px;',
    'box-shadow:0 2px 24px rgba(39,48,58,.12)}',
    '.mark{font-size:13px;letter-spacing:.14em;color:var(--survey);margin:0 0 14px}',
    'h1{font-size:20px;margin:0 0 12px;font-weight:600}',
    'p{margin:0 0 10px;line-height:1.55;font-size:15px}',
    '.email{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;',
    'background:var(--mortar);border-radius:8px;padding:8px 10px;display:inline-block}',
    '.quiet{color:#5c6672;font-size:13px}',
    '.error{color:var(--brick)}',
    '</style></head><body><div class="card"><p class="mark">KEYSTONE</p>',
    '<h1>' + escapeHtml_(heading) + '</h1>',
    bodyHtml,
    '</div></body></html>'
  ].join('');

  return HtmlService.createHtmlOutput(html)
    .setTitle('Keystone')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * The access screen for an account with no `Users` row.
 * @param {string} email
 * @return {!HtmlOutput}
 */
function renderAccessScreen_(email) {
  var signedIn = email
    ? '<p>You are signed in as <span class="email">' + escapeHtml_(email) + '</span>.</p>'
    : '<p>Google did not report a signed-in account for this request.</p>';
  return renderStandaloneScreen_('This account does not have access', [
    '<p>This Google account is not on the Keystone access list.</p>',
    signedIn,
    '<p class="quiet">Ask the owner to add this address to the Users tab of the Keystone Index sheet. ',
    'If you have more than one Google account, check that you are in the right one.</p>'
  ].join(''));
}

/**
 * A configuration error the owner has to fix in the Sheet.
 * @param {string} message
 * @return {!HtmlOutput}
 */
function renderErrorScreen_(message) {
  return renderStandaloneScreen_('Keystone is not configured yet', [
    '<p class="error">' + escapeHtml_(message) + '</p>',
    '<p class="quiet">Fix the Settings tab of the Keystone Index sheet, then reload this page.</p>'
  ].join(''));
}

/* -------------------------------------------------------------------------
 * Sheet menu
 * ---------------------------------------------------------------------- */

/** Adds the Keystone menu when the Sheet opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Keystone')
    .addItem('Open test URL', 'ksMenuOpenTestUrl')
    .addItem('Open stable URL', 'ksMenuOpenStableUrl')
    .addSeparator()
    .addItem('Update server code…', 'ksMenuUpdateServerCode')
    .addItem('Promote server code to stable…', 'ksMenuPromoteServerToStable')
    .addSeparator()
    .addItem('Diagnose access…', 'ksMenuDiagnoseAccess')
    .addToUi();
}

/** Menu: show the test deployment URL, carrying ?c=test. */
function ksMenuOpenTestUrl() {
  showDeploymentUrlDialog_('test');
}

/** Menu: show the stable deployment URL. */
function ksMenuOpenStableUrl() {
  showDeploymentUrlDialog_('stable');
}

/**
 * Show a deployment URL in a modal, because Apps Script cannot navigate the
 * parent tab.
 *
 * Both channels are versioned /exec deployments now (ADR 0001), and a script
 * cannot discover the URL of a deployment other than the one serving it, so the
 * two URLs are recorded in Settings as `test_url` and `stable_url`. The serving
 * deployment's own URL is the fallback while those are still blank.
 * @param {string} which 'test' | 'stable'
 */
function showDeploymentUrlDialog_(which) {
  var ui = SpreadsheetApp.getUi();
  var configured = String(getSetting_(which === 'stable' ? 'stable_url' : 'test_url', '')).trim();

  if (!configured) {
    try {
      configured = String(ScriptApp.getService().getUrl() || '');
    } catch (err) {
      configured = '';
    }
  }
  if (!configured) {
    ui.alert(
      'Keystone',
      'No deployment URL is recorded yet. Deploy the web app and put its URL in the Settings tab as "' +
        (which === 'stable' ? 'stable_url' : 'test_url') + '" (see docs/SETUP.md).',
      ui.ButtonSet.OK
    );
    return;
  }

  var url = withChannelParam_(configured, which);
  var label = which === 'stable' ? 'Stable URL' : 'Test URL';
  var html = [
    '<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#27303A;',
    'margin:0;padding:18px;font-size:14px;line-height:1.5}',
    'a{color:#0F7C8C;word-break:break-all}p{margin:0 0 10px}</style>',
    '<p>' + escapeHtml_(label) + ':</p>',
    '<p><a href="' + escapeHtml_(url) + '" target="_blank" rel="noopener">' + escapeHtml_(url) + '</a></p>',
    '<p style="color:#5c6672">Opens in a new tab. Bookmark this exact URL.</p>'
  ].join('');

  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(540).setHeight(200), 'Keystone — ' + label);
}
