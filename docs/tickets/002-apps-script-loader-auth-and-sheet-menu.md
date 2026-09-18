# 002 — Apps Script loader, auth, and Sheet menu
Phase: 0 · Tag: hard · Spec sections: §2, §2.1 (gates 1, 2, 4), §2.2, §3, §3.1, §13.1, §14.1, §14.2, §16, §18

## Goal

Make the deployed test URL show the Phase 0 boot cube, loaded from jsDelivr at a `build-*` tag, behind a working access check. This ticket adds the Apps Script half of Phase 0: the manifest, the `doGet` loader with tag and channel resolution, the `Users`-tab auth gate, the Sheet `Keystone` menu, the `Index.html` loading shell, and a dev route that runs and records gates 1, 2, and 4. It also writes `docs/SETUP.md`, the owner's one-time click-by-click setup.

After this ticket the owner can open the test URL and see a lit, shadowed, spinning cube served from `build-N`, and a stranger who opens the same URL sees an access screen.

The save/load API (`Api.gs`, `Storage.gs` build functions, gate 3) is ticket 003. The updater (`Updater.gs`, gate 6) is ticket 004.

## Constraint that shapes this ticket

The Builder cannot deploy or run Apps Script from a cloud session. Server code must therefore be written so its decision logic is testable without Apps Script: every pure helper (tag selection, base-URL construction, channel detection, the authorize/deny decision, settings parsing) is a plain function with no Apps Script globals in its body. `tests/server-logic.test.js` reads `src/server/Code.gs` and `src/server/Storage.gs` as text, evaluates them in a sandbox with stubbed `SpreadsheetApp` / `CacheService` / `UrlFetchApp` / `Session` globals, and tests those helpers directly. Anything that cannot be tested this way is verified by the owner on the test URL and recorded in the Handoff.

## Requirements

### 1. Files added

```
src/server/appsscript.json
src/server/Code.gs
src/server/Storage.gs
src/server/Index.html
assets/test/checker.png
docs/SETUP.md
docs/PHASE0_RESULTS.md
tests/server-logic.test.js
tests/loader-template.test.js
```

`build/build.mjs` already copies `src/server/**` verbatim to `dist/server/` and lists it under `server` in the manifest (ticket 001). No build changes should be needed; if any are, keep them minimal and say so in the Handoff.

### 2. `appsscript.json` (§2.2)

- `runtimeVersion: "V8"`, `timeZone: "America/Chicago"`, `exceptionLogging: "STACKDRIVER"`.
- `oauthScopes`: spreadsheets, drive, `script.external_request`, `script.projects`, `userinfo.email`. No others.
- `webapp`: `executeAs: "USER_ACCESSING"`, `access: "ANYONE"`.

### 3. `Storage.gs` — settings and users only

This ticket creates `Storage.gs` with just the read helpers the loader needs. Ticket 003 adds the Drive and `Builds` functions to the same file.

- `getSettings_()` — reads the `Settings` tab into a plain key/value object. Cached in `CacheService.getScriptCache()` for 300 s under `ks_settings`. `invalidateSettings_()` clears it.
- `getSetting_(key, fallback)`.
- `getUserRole_(email)` — reads the `Users` tab, returns `"owner" | "editor" | "viewer" | null`. Email comparison is lowercase and trimmed on both sides. Cached 300 s.
- `logRow_(email, action, buildId, detail)` — appends to the `Log` tab with a timestamp.
- Pure helpers, separately exported for tests: `parseSettingsRows_(rows)`, `findRole_(rows, email)`.

### 4. `Code.gs` — loader, auth, menu

**Auth.** `doGet` resolves `Session.getActiveUser().getEmail()`. Empty string, or an email with no `Users` row, is denied. Denied requests render the access screen (see §6 below) and append one `Log` row with action `access_denied`. Authorized requests do not write a log row.

**Channel.** `channel = "test"` when `ScriptApp.getService().getUrl()` ends with `/dev`, otherwise `"stable"`. An `?channel=` query parameter overrides this only when the caller's role is `owner`; any other caller's parameter is ignored silently.

**Tag resolution.**

- `stable` → `stable_tag` from `Settings`.
- `test` → newest `build-*` tag, fetched from `https://api.github.com/repos/{github_repo}/releases?per_page=30` with `UrlFetchApp` (`muteHttpExceptions: true`), filtering tag names matching `^build-\d+$` and sorting by the numeric suffix descending. Cached in `CacheService.getScriptCache()` for 60 s under `ks_tags`. Cache the two newest tags, not just one — the loader's "Try the previous build" needs the second.
- If the GitHub fetch fails or returns no matching tag, fall back to `stable_tag` and set a `degraded` flag that the loading screen surfaces as a one-line banner naming what failed.
- If `stable_tag` is also missing or empty, render an error page that names the missing `Settings` key and links the Sheet. Never render a page that would load from a broken URL.

**Base URL.** `asset_base_url` from `Settings`, default `https://cdn.jsdelivr.net/gh/rebelribbon/keystone@{tag}`. `{tag}` is substituted with the resolved tag. A trailing slash in the setting is stripped. The loader then requests `{base}/dist/client/<file>`.

**`doGet`** builds the template, sets the page title to `Keystone`, adds the viewport meta tag, and returns `HtmlService.createTemplateFromFile("Index").evaluate()` with `XFrameOptionsMode.ALLOWALL`.

**`include(filename)`** returns `HtmlService.createHtmlOutputFromFile(filename).getContent()`.

**`api_whoami()`** (§14.2) — returns `{ email, role }` or a structured `{ code: "ACCESS_DENIED", message }`. This is the only `Api.*` function in this ticket; the rest are 003.

**`api_getBundle_(tag, file)`** — server-side fetch of one bundle via `UrlFetchApp`, base64-encoded, chunked into `CacheService` under `ks_bundle_<tag>_<file>_<i>` with a 6 h TTL, returned to the client in chunks. This is the §2.1 gate 1 fallback path. See the decision in §8 below for how it is reached.

**`onOpen()`** — adds a `Keystone` menu with exactly two items in this ticket: *Open test URL* and *Open stable URL*, each showing a modal with the clickable URL (Apps Script cannot navigate the parent tab). *Update server code* is added by ticket 004; do not add a disabled or placeholder item for it.

Pure helpers exported for tests: `pickNewestBuildTags_(releaseJson)`, `buildBaseUrl_(assetBaseUrl, tag)`, `resolveChannel_(serviceUrl, paramChannel, role)`, `decideAccess_(email, role)`.

### 5. `Index.html` — loader shell (§3.1)

Emits, in this order, all with `defer`:

1. `<link rel="stylesheet" href="{base}/dist/client/styles.css">` and the Manrope link (`wght@400;600;700`).
2. `{base}/dist/client/vendor-three.js`
3. `{base}/dist/client/engine.js`
4. `{base}/dist/client/catalog-materials.js`, `catalog-styles.js`, `catalog-exterior.js`, `catalog-interior.js`
5. An inline boot block calling `KS.boot({ tag, channel, user })`.

`tag`, `channel`, `user`, `base`, `previousTag`, and `degraded` are injected by the template as a single JSON blob in one `<script>` tag before the others. Escape it with `JSON.stringify` through `HtmlService`'s scriptlet — never string-concatenate user or settings values into the page.

**Loading screen.** Uses the `.ks-loading` block that ticket 001 put in `styles.css` (extend that file if it needs more; keep it to the §13.1 tokens). Shows one row per file with a pending/loaded/failed state, driven by each script tag's `onload` and `onerror`. It hides once `KS.boot` returns.

**Failure state.** If any file errors, the screen stops, names the failed file and the tag, and shows a *Try the previous build* button that reloads with `?tag=<previousTag>` — honored only for role `owner`, same rule as `?channel=`. If there is no previous tag, the button is absent and the message says so.

**No `localStorage`.** The loader stores nothing client-side.

### 6. Access screen

A separate, self-contained HTML output (no external scripts, no jsDelivr dependency, inline CSS using the §13.1 token values): the Keystone name, one sentence saying this account is not on the access list, the signed-in email so the owner can tell which account they are in, and a line telling them to ask the owner for access. No sign-out link, no retry loop.

### 7. Gates 1, 2, and 4 — `?dev=gates`

An owner-only route that renders a results panel instead of the cube. It runs:

- **Gate 1 (loader).** Records `performance.now()` at the inline boot block and at the first rendered frame. PASS when every bundle loaded from jsDelivr and first render is under 6000 ms. Reports the measured value either way.
- **Gate 2 (texture).** Generates a canvas texture through a small procedural checker function and loads `{base}/assets/test/checker.png` as a `THREE.Texture`, applying both to two quads. PASS when both render with no console CORS error. `assets/test/checker.png` is a small in-house generated checkerboard — no third-party art.
- **Gate 4 (storage).** Opens an IndexedDB database inside the deployed iframe, writes a record, reads it back, deletes the database. PASS on a byte-identical read-back. FAIL is not an error condition; it selects the memory fallback for the thumbnail cache later, and the panel says so.

The panel prints a table of gate, result, measured value, and notes, plus the tag and channel, ready to screenshot. Gates 3 and 6 show as `not in this ticket`.

`docs/PHASE0_RESULTS.md` is created with the table's headings and rows for all six gates, gates 1, 2, and 4 filled in from the owner's run, the other three left as `pending — ticket 003 / 004`.

### 8. Decisions taken (do not re-litigate; raise in Handoff only if one is unworkable)

- **The jsDelivr fallback is explicit, not automatic.** A new `Settings` key `loader_mode` takes `cdn` (default) or `inline`. On `inline`, `Index.html` omits the external script tags and instead pulls each bundle through `api_getBundle_` and injects it. Automatic detection of a blocked external script is not built: the reliable signals are all timing heuristics, and a wrong guess doubles load time on every page view. If gate 1 fails on `cdn`, the owner flips one cell and re-tests. Record the reason in `docs/DEFERRED.md`.
- **`Storage.gs` is created here, not in 003**, so the loader is not reading the Sheet through ad-hoc code that 003 would have to rip out.
- **Denied access is logged; granted access is not.** Logging every page view would bury the `Log` tab.
- **`?channel=`, `?tag=`, and `?dev=` are owner-only.** They are debugging affordances, and the web app is open to anyone with a Google account.

### 9. Docs

- **`docs/SETUP.md`** — the owner's one-time setup, click by click, in this order: create the four Sheet tabs with the exact §14.1 headers; create the `Keystone Builds` Drive folder and copy its ID; Extensions → Apps Script to bind the project; create each server file and paste its contents from `dist/server/` at the current tag; set the manifest scopes; deploy as a web app twice (test `/dev`, stable versioned) with execute-as and access settings from §2.2; fill the six `Settings` rows; add the owner's row to `Users`; reload the Sheet to get the `Keystone` menu. Include the exact `Settings` keys and their starting values, with `github_repo` = `rebelribbon/keystone` and `stable_tag` = `build-1`. State plainly that no software is installed at any point.
- **`CHANGELOG.md`** — add the `002` entry with the spec sections touched.

## Out of scope

- `Api.gs` and every save/load function in §14.2 other than `api_whoami`. Gate 3. — ticket 003.
- `Updater.gs`, the *Update server code* menu item, gate 6. — ticket 004.
- Any engine work: store, commands, events, camera, terrain, real scene. The page still boots the Phase 0 cube from ticket 001.
- Any catalog content.
- The `Builds` gallery screen, the new-build wizard, and every UI panel in §13.2.
- Promoting `stable_tag` past `build-1`.

## Acceptance

- [ ] `npm test` and `npm run build` pass; `dist/server/` now contains `appsscript.json`, `Code.gs`, `Storage.gs`, and `Index.html`, and `manifest.json` lists them under `server`.
- [ ] `tests/server-logic.test.js` passes and covers: `pickNewestBuildTags_` (picks `build-12` over `build-9`, ignores non-matching tag names, returns two tags, handles an empty release list); `buildBaseUrl_` (substitutes `{tag}`, strips a trailing slash); `resolveChannel_` (`/dev` → test, `/exec` → stable, param honored for owner, ignored for editor and viewer); `decideAccess_` (empty email denied, unlisted email denied, listed email allowed, comparison is case- and whitespace-insensitive); `parseSettingsRows_` and `findRole_`.
- [ ] `tests/loader-template.test.js` passes and asserts the `Index.html` template emits the seven `{base}/dist/client/...` references in §3.1 order, every script tag carries `defer`, and the file contains no `localStorage`.
- [ ] Following `docs/SETUP.md` start to finish, with nothing installed, produces a working test URL. The owner does this once and notes anything ambiguous.
- [ ] Opening the test URL as the owner shows the loading screen, then a lit, shadowed, spinning cube, with the tag and channel visible in the browser console.
- [ ] Opening the same URL from a Google account that has no `Users` row shows the access screen, and a single `access_denied` row lands in the `Log` tab.
- [ ] Merging a new PR to `main` produces `build-2`, and the test URL serves it within two minutes with nobody touching Apps Script.
- [ ] Setting `stable_tag` to `build-1` makes the stable deployment serve `build-1` while the test URL serves the newest tag.
- [ ] `?dev=gates` as the owner reports PASS for gates 1, 2, and 4, with gate 1's measured first-render time under 6000 ms. Results are transcribed into `docs/PHASE0_RESULTS.md` and screenshotted in the Handoff.
- [ ] Killing the GitHub Releases fetch (set `github_repo` to a nonexistent repo) makes the page fall back to `stable_tag` and show the degraded banner rather than failing.
- [ ] No secrets, Sheet IDs, or Drive folder IDs anywhere in the repo. `docs/SETUP.md` tells the owner where to put them; it does not contain them.
- [ ] No `TODO` in `src/`, no shipped placeholder menu items, `docs/DEFERRED.md` updated with the auto-detection cut.

## Handoff (Builder fills in)

### What changed

The Apps Script half of Phase 0. `doGet` now resolves the signed-in account
against the `Users` tab, picks a channel and a build tag, and renders the §3.1
loader shell that pulls the ticket-001 bundles from jsDelivr. Unlisted accounts
get the access screen and one `access_denied` Log row. The owner-only
`?dev=gates` route runs gates 1, 2, and 4 and prints a screenshot-ready table.

### Files touched

Added: `src/server/appsscript.json`, `src/server/Code.gs`, `src/server/Storage.gs`,
`src/server/Index.html`, `assets/test/checker.png`, `docs/SETUP.md`,
`docs/PHASE0_RESULTS.md`, `tests/server-logic.test.js`, `tests/loader-template.test.js`,
three harness screenshots under `screenshots/`.

Updated: `CHANGELOG.md`, `docs/DEFERRED.md`.

Changed beyond the ticket's file list, both minimal and both forced by a real defect:

1. **`build/build.mjs`** — manifest entries sorted with `localeCompare`, which is
   locale/ICU dependent. With mixed-case server filenames (`Code.gs` vs
   `appsscript.json`) that ordering diverged from plain codepoint order and broke
   `manifest.test.js`. Switched both sorts to codepoint order so the manifest is
   byte-identical in a cloud session and on an Actions runner. The ticket asked me
   to flag any build change: this is it.
2. **`src/client/ui/styles.css`** — added `.ks-loading[hidden] { display: none }`.
   The ticket explicitly allows extending this file for the loading screen. The
   `.ks-loading` class sets `display: flex`, which out-specifies the user-agent
   `[hidden]` rule, so `loadingEl.hidden = true` set the attribute but left the
   overlay covering the cube. Caught by rendering the page, not by a test.

### Verified in-session

`npm test` (68 tests across 5 files) and `npm run build` both pass. `dist/server/`
contains the four server files and `manifest.json` lists them under `server`.

Because the cloud session cannot deploy Apps Script, I rendered
`src/server/Index.html` through a local stand-in for `HtmlService` templating
(same `<? ?>` / `<?= ?>` / `<?!= ?>` semantics), served the real built bundles over
HTTP, and drove it in headless Chromium:

- **Happy path** — loading screen lists six bundles, all go green, screen hides,
  lit shadowed spinning cube renders, console logs
  `[KS] boot {tag, channel, user}`. All four catalog packs registered.
  (`screenshots/002-loader-cube-harness.png`)
- **Failure path** — with `engine.js` returning 404, the screen stops, marks that
  file red, names the file and the tag, and offers *Try the previous build
  (build-0)*. (`screenshots/002-loader-failure-harness.png`)
- **Degraded path** — the banner renders the fallback reason text.
- **`?dev=gates`** — gate 1 PASS (376 ms to first frame, budget 6000), gate 2 PASS
  (procedural canvas texture and the jsDelivr PNG both render, no CORS error),
  gate 4 PASS (byte-identical IndexedDB read-back). Gates 3 and 6 show
  `not in this ticket`. (`screenshots/002-dev-gates-harness.png`)

**These harness numbers are not gate results.** They exercise the template and the
client code, not Apps Script, `HtmlService`, the iframe sandbox, or real jsDelivr.
`docs/PHASE0_RESULTS.md` keeps gates 1, 2, and 4 `pending` until you run
`?dev=gates` on the deployed test URL.

One defect the harness caught before deployment: `Index.html` reads `devGates`,
but `doGet` never assigned it to the template. In Apps Script that is a
`ReferenceError` during `evaluate()`, which would have broken **every** page load,
not just the gates route. Fixed.

### How you verify it

Follow `docs/SETUP.md` start to finish — about 30 minutes, nothing installed.
Then, from the ticket's acceptance list:

1. Test URL as you: loading screen, then the cube. Console shows tag and channel.
2. A Google account with no `Users` row: access screen, and exactly one
   `access_denied` row in `Log`.
3. `?dev=gates` as owner: PASS on 1, 2, 4 with gate 1 under 6000 ms. Transcribe
   into `docs/PHASE0_RESULTS.md` and screenshot.
4. Set `github_repo` to a nonexistent repo: the page falls back to `stable_tag`
   and shows the degraded banner instead of failing. Put it back afterwards.
5. Merge the next PR: `build-2` appears and the test URL serves it within two
   minutes with nobody touching Apps Script.
6. With `stable_tag` = `build-1`, the stable `/exec` URL serves `build-1` while
   `/dev` serves the newest tag.

### Decisions and readings worth your eye

- **The gates panel overlays the cube rather than replacing it.** The ticket says
  "renders a results panel instead of the cube", but gate 1 measures the cube's
  first rendered frame and gate 2 needs `window.THREE`, so the page still boots
  normally and the panel is a full-screen scrollable overlay on top. Say the word
  and I will suppress the cube and measure a bare render instead.
- **"Every script tag carries `defer`" is asserted for external scripts only.**
  `defer` is a no-op on inline scripts, so adding it there would be decoration.
  Ordering is still guaranteed: the boot block waits for `DOMContentLoaded`, which
  fires after every deferred script has run. The test asserts all six external
  tags carry `defer`.
- **The *Try the previous build* button is shown only to an owner.** `?tag=` is
  owner-only server-side, so rendering the button for an editor or viewer would be
  a button that silently does nothing. Non-owners get a line naming the tag to ask
  you for instead.
- **`api_getBundle_` is reached server-side, during template evaluation.** Its
  trailing underscore makes it private to `google.script.run` by design, and inline
  mode needs the source inlined into the page anyway, so `doGet` calls it while
  building the template rather than exposing it to the client.
- **Boot payload injection.** Everything the page needs is one `toSafeJson_` blob
  that escapes `<`, `>`, and `&`, so no settings or user value can terminate the
  script element. `tests/loader-template.test.js` fails if any other unescaped
  scriptlet output appears in the template.

### Known issues / open questions

- `src/server/` is not linted or type-checked; the `.gs` files are only compile-
  checked and exercised through the sandbox tests. Anything touching
  `SpreadsheetApp`, `HtmlService`, `ScriptApp`, or `UrlFetchApp` at runtime is
  unverified until you deploy.
- `inline` loader mode is implemented but never executed end to end — no way to
  run `UrlFetchApp` here. If gate 1 fails on `cdn`, expect to shake this path out.
  `vendor-three.js` is ~684 KB, about 912 KB base64, roughly ten `CacheService`
  chunks; that is within limits but it is the riskiest untested path in the ticket.
- The Manrope font request fails in this sandbox (TLS interception on
  `fonts.googleapis.com`). That is the environment, not the code; it will load in
  your browser.
- `docs/PHASE0_RESULTS.md` gates 1, 2, and 4 are yours to fill from the real run.
