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
