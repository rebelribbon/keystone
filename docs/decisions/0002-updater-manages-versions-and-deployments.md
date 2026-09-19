# ADR 0002 — The updater creates versions and repoints deployments

Date: 2026-09-19 · Status: Accepted · Amends: SPEC §2.2 (manifest scopes), §3.2 (updating) · Relates to: ADR 0001 · Author: Architect

## Context

SPEC §2.1 gate 6 defines the updater as pulling `dist/server/*` from a chosen tag and overwriting the Apps Script project files through the Apps Script API. §3.2 then says the owner finishes the job by hand: "for stable, owner then creates a new version under Deploy → Manage deployments."

ADR 0001 made that manual step worse. With `/dev` out of the model, both channels are versioned `/exec` deployments, so a server change now needs a new version on **two** deployments instead of one. The updater as specified would replace a copy-paste ritual with a click-through ritual, and the owner has already performed the full ritual four times across Phase 0.

Writing project content requires `script.projects`, which §2.2 already grants. Creating a version and repointing a deployment requires `script.deployments`, which it does not.

## Decision

1. **Add `https://www.googleapis.com/auth/script.deployments` to the manifest scopes.**

2. **The updater performs the whole sequence**: fetch `dist/server/*` at the chosen tag, verify each file's SHA-256 against `dist/manifest.json`, write the project content, create a new Apps Script version, and repoint a deployment at it.

3. **Test is automatic; stable is a separate, explicit confirmation.** One run of *Update server code* writes the files, versions, and repoints the **test** deployment without further prompting. Promoting that same version to **stable** is a second menu action the owner invokes deliberately, after testing. Automatic promotion to stable is not built and should not be.

4. **Every run writes a backup** of the project's current content to a JSON file in the Builds folder before touching anything.

## Consequences

- The copy-paste-and-deploy ritual ends for the test channel. Stable stays one deliberate click, which is the point of having a stable channel at all.
- **Adding a scope forces re-authorization.** The first run after this lands prompts the owner for consent again, and every other user the next time they open the web app. This is a one-time cost and must be called out in `docs/SETUP.md` so it does not read as a failure.
- The token the script holds now carries deployment-management authority. It stays server-side; it is never passed to the page. This is the opposite of the rejected client-side Drive token in ticket 005, and the distinction is exactly that: server-held tokens are fine, tokens handed to a page that loads code from a public CDN are not.
- A bad server push can break the test channel. The backup file plus the documented paste fallback (§2.1 gate 6) are the recovery path. Stable is unaffected until the owner promotes.
- `docs/SETUP.md`'s deployment section shrinks: the owner creates the two deployments once, and never edits a version by hand again unless recovering.

## Alternatives rejected

- **Leave versioning manual, as §3.2 says.** Rejected: ADR 0001 doubled the manual work, and the owner correctly identified the ritual as the thing worth deleting.
- **Auto-promote to stable too.** Rejected: stable exists so that a broken push has somewhere safe to fall back to. Automating the promotion removes the only property that makes it stable.
- **Skip the API and keep pasting.** Rejected: it is gate 6, and it is the single largest recurring cost in the owner's loop.
