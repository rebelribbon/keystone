# 004 — Server updater and gate 6
Phase: 0 · Tag: hard · Spec sections: §2.1 (gate 6), §2.2, §3, §3.2, §16, §18 · Decisions: ADR 0001, ADR 0002

## Goal

End the copy-paste-and-deploy ritual. A menu item in the Sheet pulls `dist/server/*` from a chosen `build-*` tag, verifies it against the release manifest, writes it into the bound Apps Script project through the Apps Script API, creates a new version, and repoints the **test** deployment at it. Promoting that version to **stable** is a second, deliberate menu action.

This closes Phase 0 gate 6, the last open gate, and with it Phase 0.

Per ADR 0002 this ticket adds the `script.deployments` scope. Be aware that the first run after merge re-prompts for authorization.

## Requirements

### 1. Manifest

Add `https://www.googleapis.com/auth/script.deployments` to `oauthScopes` in `src/server/appsscript.json`. No other scope changes.

Land ADR 0002 as `docs/decisions/0002-updater-manages-versions-and-deployments.md`, verbatim as provided.

### 2. `Updater.gs`

New file. Everything here is owner-only: a non-owner invoking any updater function gets a structured refusal, not a partial run.

**Tag picker.** `showUpdateDialog_()` opens a modal listing the newest ten `build-*` tags from the GitHub Releases API, reusing `pickNewestBuildTags_` from ticket 002 rather than a second copy of that logic. Each row shows the tag, its release date, and a marker on the tag whose server files currently match the project (see the fingerprint below). The owner picks one and confirms.

**Fetch and verify.** For the chosen tag:

1. Fetch `{base}/dist/manifest.json`.
2. Read its `server` array — ticket 001 put it there for exactly this.
3. Fetch each listed file from `{base}/<path>`.
4. Compute SHA-256 of each fetched file and compare against the manifest's entry for that path. **Any mismatch aborts the whole run before anything is written.** A partial or tampered server push is worse than a stale one.
5. Abort with a clear message if the manifest has no `server` entries, rather than proceeding to write an empty project.

**Map dist filenames to Apps Script API entries.** The API's content model is `files: [{ name, type, source }]` with the extension stripped from `name`:

| dist path | name | type |
|---|---|---|
| `dist/server/appsscript.json` | `appsscript` | `JSON` |
| `dist/server/Code.gs` | `Code` | `SERVER_JS` |
| `dist/server/Api.gs` | `Api` | `SERVER_JS` |
| `dist/server/Storage.gs` | `Storage` | `SERVER_JS` |
| `dist/server/Updater.gs` | `Updater` | `SERVER_JS` |
| `dist/server/Index.html` | `Index` | `HTML` |

Derive the mapping from the extension rather than hardcoding this table, so a new server file added in a later ticket needs no updater change. Unknown extensions abort the run.

**Write project content — merge, never replace wholesale.** `PUT https://script.googleapis.com/v1/projects/{scriptId}/content` replaces the **entire** project. Any file absent from the payload is deleted. Therefore:

1. `GET` the current content first.
2. Replace entries whose `name` matches an incoming file.
3. Preserve every existing entry that the incoming set does not name.
4. **Refuse to PUT if the payload would omit `appsscript`.** Losing the manifest destroys the scopes and the web app configuration, and the recovery is painful.

`scriptId` comes from `ScriptApp.getScriptId()`. The bearer token comes from `ScriptApp.getOAuthToken()` and never leaves the server.

**Backup before writing.** Write the `GET` response to `server-backup-<ISO timestamp>.json` in the Builds folder before the `PUT`. Keep the ten most recent and delete older ones. Document the manual restore path in `docs/SETUP.md`; do not build a restore UI in this ticket.

**Version and repoint test.** After a successful write:

1. `POST .../versions` with a description of `build-N via updater`.
2. `PUT .../deployments/{testDeploymentId}` pointing at the new version number.

`testDeploymentId` and `stableDeploymentId` are new `Settings` keys. The owner fills them once from Deploy → Manage deployments. If either is missing, the updater still writes the files and creates the version, then tells the owner exactly which Settings key to fill — it does not silently skip the step.

**Promote to stable.** A separate menu item, *Promote server code to stable*. It shows which version each deployment currently serves, asks for explicit confirmation naming the version and the tag, then repoints the stable deployment. It never creates a version; it only promotes one that already exists and has been on test.

**Fingerprint.** Store the tag and the manifest's server-file digests in `Settings` under `server_tag` and `server_fingerprint` after each successful write. The tag picker uses it to mark the current tag, and `?dev=gates` displays it so there is always an answer to "what server code is actually running."

**Completion dialog.** State plainly: which tag was written, which version number was created, that the test deployment now serves it, and that stable still serves its previous version until promoted. Include both deployment URLs.

### 3. Menu

`onOpen()` gains two items alongside the two from ticket 002:

- *Update server code…*
- *Promote server code to stable…*

Both owner-only. A non-owner selecting one gets a one-line "owner only" toast, not a stack trace.

### 4. Gate 6 and closing Phase 0

- `docs/PHASE0_RESULTS.md`: fill in gate 6 with the tag written, the version created, elapsed time, and confirmation that the test URL served the new server code with nobody opening the Apps Script editor. All six gates are now recorded; add a closing line stating the channel each was verified on.
- `docs/SETUP.md`: replace the "paste the server files" section with first-time setup only (paste once to bootstrap, since the updater cannot install itself), then the two deployment IDs into `Settings`, then a note that every subsequent server change goes through the menu. Add the re-authorization warning from ADR 0002 and the manual restore-from-backup procedure.
- `CHANGELOG.md`: the `004` entry.

## Out of scope

- Any automatic promotion to stable. ADR 0002 rejects it on purpose.
- A restore-from-backup UI. The backup file is written; restoring is documented.
- Any client-side or engine work.
- The `v0.0.0` phase tag and `docs/reviews/phase-0.md` — the owner cuts the tag and the Architect writes the review once this merges.
- Rolling the release workflow's `paths-ignore` change. Still unticketed.

## Acceptance

- [ ] `npm test` and `npm run build` pass; `dist/server/Updater.gs` appears in the manifest's `server` array.
- [ ] `tests/server-logic.test.js` extended, using the eval-sandbox harness, covering: extension-to-API-type mapping including an unknown extension aborting; the merge preserving an unlisted existing file; the refusal to PUT when `appsscript` would be omitted; a SHA-256 mismatch aborting before any write; an empty `server` array aborting; non-owner refusal on every updater entry point.
- [ ] Live run: from the Sheet menu, update server code to the newest tag. The project files change without the Apps Script editor being opened, a new version is created, and the test deployment serves it. Record elapsed time.
- [ ] Immediately after that run, the test URL reflects a deliberate, visible server-side change (for example a bumped `server_tag` shown by `?dev=gates`), and the stable URL still shows the old one.
- [ ] *Promote server code to stable* then makes the stable URL match, and only after explicit confirmation.
- [ ] A backup JSON file appears in the Builds folder before each write, and only the ten most recent are kept.
- [ ] Deliberately corrupt the check: point `github_repo` at a tag whose manifest digest does not match a fetched file, and confirm the run aborts with nothing written.
- [ ] Clearing `testDeploymentId` from `Settings` produces the named-key message, and the file write and version creation still succeed.
- [ ] `docs/PHASE0_RESULTS.md` shows all six gates recorded with their channels; `docs/SETUP.md` covers bootstrap paste, deployment IDs, re-auth, and restore.
- [ ] No secrets, script IDs, or deployment IDs committed to the repo. They live in `Settings`.
- [ ] No `TODO` in `src/`, no `localStorage`.

## Handoff (Builder fills in)

### What changed

`src/server/Updater.gs` (new) does the whole sequence: tag picker → fetch
`dist/server/*` at that tag → SHA-256 every file against the release manifest →
merge into the project through the Apps Script API → new version → repoint the
**test** deployment. *Promote server code to stable* is a separate menu item that
creates nothing.

Files: `src/server/Updater.gs` (new), `src/server/appsscript.json` (the
`script.deployments` scope), `src/server/Code.gs` (two menu items,
`pickNewestBuildTags_` limit, `server_tag`/`server_fingerprint` in the boot
payload), `src/server/Storage.gs` (`writeSetting_` extracted), `src/server/Api.gs`
(`api_setSetting` delegates to it), `src/server/Index.html` (`?dev=gates` prints
the running server code), `tests/server-logic.test.js`, `tests/manifest.test.js`,
`docs/decisions/0002-...md`, `docs/SETUP.md`, `docs/PHASE0_RESULTS.md`,
`CHANGELOG.md`, four screenshots.

165 tests across 7 files pass; `npm run build` passes and
`dist/server/Updater.gs` is in the manifest's `server` array.

### Verified in-session

Two levels, because the gate itself needs a deployment I cannot reach.

**1. Unit, against the eval sandbox.** 33 new tests. Every acceptance item that
is testable without Apps Script: the extension→type mapping and an unknown
extension aborting; the merge preserving an unlisted `Scratch` file; the refusal
when `appsscript` would be omitted; a digest mismatch aborting with zero API
calls and zero Drive writes; an empty `server` array aborting; backup pruning to
ten; `FORBIDDEN` for an editor and `ACCESS_DENIED` for an unlisted account on all
four entry points, with nothing written; the missing-`testDeploymentId` path
still writing and versioning and naming the key; and the OAuth token appearing in
no result, no log row, and no backup.

`tests/manifest.test.js` now asserts against the **real build** that
`manifest.server` lists every `src/server/` file, that each one's digest matches
the file on disk, and that every extension is one the updater can classify. Those
two tests are what stop a future server file silently breaking every update run.

**2. Both dialogs driven in a real browser.** The real `Updater.gs`, `Code.gs`,
`Storage.gs` and `Api.gs` run in a Node sandbox with in-memory Apps Script
stand-ins — including a fake jsDelivr serving this repo's own server files under
a real manifest, and a fake Apps Script API — behind a `google.script.run` shim,
with the actual dialog markup loaded in headless Chromium.

| Run | Result |
|---|---|
| Picker | six tags listed with dates, `build-9` badged *running now*, fingerprint shown |
| Write | 6 files, version 12, test repointed, backup written, no page errors |
| Promote confirm | "Test serves version 12 (tag build-9). Stable serves version 7." |
| Promote | "Stable now serves version 12 (tag build-9), up from version 7." |

Screenshots: `screenshots/004-updater-picker.png`, `004-updater-done.png`,
`004-promote-confirm.png`, `004-promote-done.png`.

That second level exists because the dialog markup is assembled as a string
inside a `.gs` file, where a quoting slip is invisible until the owner clicks the
menu item. A test also parses each dialog's inline script with `vm.Script`, which
caught one real defect before the browser run.

**Read the sandbox as a shape check, not a deployment prediction.** A fake Apps
Script API answers instantly and cannot reproduce quota, latency, or Google's
own validation of a `PUT .../content` payload. What it proves is that the
sequence, the merge, the digest gate, the refusals and both dialogs behave as
specified against real code.

### What you have to run — this is gate 6

`docs/PHASE0_RESULTS.md` has the table to fill in. In order:

1. **Before anything else, turn on the Apps Script API** at
   <https://script.google.com/home/usersettings>. It is off by default on every
   Google account and the updater cannot work without it. `docs/SETUP.md` step 6b.
2. Bootstrap `Updater.gs` and `Api.gs` into the project by hand one last time,
   and re-paste `appsscript.json` for the new scope. The updater cannot install
   itself.
3. Put both deployment IDs into `Settings` as `testDeploymentId` and
   `stableDeploymentId` (*Deploy → Manage deployments*, the ID, not the URL).
4. **Keystone → Update server code…** Pick the newest tag, write it, and record
   the elapsed time the dialog reports.
5. Check `?dev=gates` on the **test** URL shows the new `server_tag`, and on the
   **stable** URL still shows the old one. That split is the gate.
6. **Keystone → Promote server code to stable…**, confirm, and check stable now
   matches.
7. Confirm a `server-backup-*.json` appeared in the Builds folder.
8. The deliberate-corruption check in the acceptance list: point `asset_base_url`
   at a tag whose manifest and files disagree and confirm the run aborts with
   nothing written. I could not construct that against the real CDN without
   publishing a bad release, so it is tested in the sandbox only.
9. Clear `testDeploymentId` and confirm the run still writes and versions and
   names the key.

**Expect an authorization prompt on the first run** and for every other user the
next time they open the web app. ADR 0002 predicted it; it is the new scope, not
a failure.

### Deviations and judgement calls

- **`pickNewestBuildTags_` gained an optional `limit`, defaulting to 2.** The
  ticket says reuse it rather than copy it, and it was hard-capped at two. The
  loader's calls are unchanged; the picker passes 10. `releaseDatesByTag_` supplies
  only the dates, so tag selection and ordering still live in one place.
- **The dialog markup is an inline string, not a seventh project file.** SPEC §3's
  server tree lists six files and every extra one is another paste in the owner's
  bootstrap. The extension-derived mapping would have handled a
  `UpdaterDialog.html` fine — this is a bootstrap-cost call, not a capability gap.
- **`writeSetting_` was extracted from `api_setSetting` into `Storage.gs`.** The
  updater has to write `server_tag` and `server_fingerprint`, and a second upsert
  against the Settings tab is exactly the kind of duplicate that drifts.
- **`testDeploymentId` and `stableDeploymentId` are camelCase**, against the
  snake_case of every other Settings key. The ticket names them that way and a
  Settings key is not something to rename later, so they ship as written.
  `docs/SETUP.md` calls the inconsistency out so it does not read as a typo.
- **Promotion re-checks the version before it moves.** The dialog passes back the
  version number it displayed, and the server refuses with `UPDATER_VERSION_MOVED`
  if test has moved on. The ticket asks for explicit confirmation naming the
  version; confirming against a number that has since changed is not that.
- **A deliberate extra gate: the Apps Script API must be switched on per
  account.** It is off by default, it is not mentioned in the ticket or the spec,
  and without it every run fails with a bare 403. `updaterApiHint_` turns 401, 403
  and 404 into the actual fix, and `docs/SETUP.md` has a step for it.
- **No restore UI**, as the ticket directs. The manual procedure is in
  `docs/SETUP.md`, and it leads with the real answer: re-run the updater against
  the previous tag. Stable is untouched until promotion, so a bad test push is
  never an emergency.

### Not done in this ticket

- **Gate 6's row in `docs/PHASE0_RESULTS.md` is a table of `_pending_`.** It can
  only be filled from a live run. Everything around it is recorded.
- The `v0.0.0` phase tag and `docs/reviews/phase-0.md` — out of scope, owner and
  Architect.
- The release workflow's `paths-ignore` change — still unticketed.

### Still open from earlier tickets

**Ticket 006 fixes the one that matters**: a throwing `CacheService` currently
reads as `ACCESS_DENIED` for every user. It landed in this branch as a ticket
file and is not implemented here. Nothing in 004 makes it worse, but note that
the updater's own entry points go through `requireAccess_`, so they inherit it —
a cache blip during an update run would refuse the owner with "not on the access
list" rather than a cache error. 006 is worth doing before the next server push.
