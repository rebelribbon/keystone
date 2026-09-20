# 009 — Channel resolution and tag source
Phase: 1 · Tag: normal · Spec sections: §2.2, §3.1, §3.2, §19 · Decisions: ADR 0001 (premise falsified), ADR 0003

## Goal

Two things, plus a rule.

The test channel has never once loaded, across the entire project. Every attempt returns Google's Drive "unable to open the file" page. ADR 0001 attributed that to the `/dev` URL and moved to a versioned `/exec` deployment; the versioned test deployment fails identically, so that premise is wrong. Stable — also a versioned `/exec` deployment of the same script, with the same scopes, opened by the same account — works every time. **Two deployments of one script, one working and one not, is a diagnosable difference. Find it before designing around it.** Part A does that. Part B is the decided fallback if it cannot be fixed.

Part C moves the newest-tag lookup off `api.github.com` per ADR 0003. It lands regardless of how A resolves.

Part D adds a standing verification rule to `CLAUDE.md`.

## Part A — Diagnose the test deployment

Bounded investigation, owner-driven, Builder-documented. Do not write a fix until the finding is written down.

Compare the two deployments side by side and record every value in `docs/decisions/0004-test-deployment-finding.md`:

| | stable | test |
|---|---|---|
| Deployment ID | | |
| Deployment type (Web app / API executable / Library / Add-on) | | |
| Execute as | | |
| Who has access | | |
| Version number served | | |
| Full URL as copied from Manage deployments | | |
| Full URL as it appears in the owner's bookmark | | |
| URL after Google's rewrite, copied from the address bar on failure | | |

Then, in a browser signed into **multiple** Google accounts, open each of the following and record exactly what renders:

1. Stable URL, bare.
2. Stable URL with `?c=test`.
3. Test URL, bare.
4. Test URL with `?c=test`.
5. Test URL, freshly re-copied from Manage deployments in this session rather than from the bookmark.
6. Test URL in a browser profile signed into exactly **one** Google account.
7. Test URL with `/u/0/` forced into the path, if Google's rewrite inserted a different index.

Cases 5, 6, and 7 are the ones that discriminate. A stale or wrong-account URL fails at 3 and succeeds at 5. A genuine multi-account platform limit fails at 3 and succeeds at 6 while stable succeeds at 1 — which would be contradictory and means the difference is in the deployment configuration, not the browser. A deployment-type or access misconfiguration usually shows in the table above before any URL is opened.

**The finding is the deliverable of Part A**, written as ADR 0004 with the evidence table, whether or not it produces a fix. If the difference is configuration, fix it, keep both deployments, and Part B is skipped — say so in the ADR.

Do not spend more than one session on this. If it is not isolated by then, declare it unresolved in ADR 0004 and take Part B.

## Part B — Fallback: collapse to one deployment

Only if Part A fails to produce a working test deployment.

The channel and the deployment are separable, and ADR 0001 already separated them: since that change, the channel is `?c=test`, a query parameter selecting which jsDelivr tag the page loads. It has never needed a second deployment.

- The stable deployment serves both channels. `?c=test` on the working URL loads the newest tag; bare loads `stable_tag`. No code change is required for this — it is already how `resolveChannel_` works.
- Retire the test deployment. Remove `testDeploymentId` from `Settings` and from the updater's flow; *Update server code* writes files and creates a version, and *Promote server code to stable* repoints the one deployment.
- **Server changes lose their pre-production surface.** State this plainly in `docs/SETUP.md` rather than letting it be discovered: after this, testing a server change means promoting it and, if it is bad, restoring from the ticket-004 backup. That is a real regression, and it is the price of a test deployment that does not work. If Part A is later solved, the second deployment comes back.
- Update `docs/SETUP.md` and the Sheet menu to show one URL plus the `?c=test` variant.

Record the outcome in ADR 0004 either way.

## Part C — Tag source (ADR 0003)

Lands regardless of A and B.

- Add `docs/decisions/0003-tag-source-moves-off-the-github-api.md`, verbatim as provided.
- Replace the newest-tag lookup with a fetch of `{cdn}/gh/rebelribbon/keystone@release/dist/manifest.json`, reading its `tag`. Cache 60 s under the existing key. The CDN host comes from the existing `asset_base_url` setting's host, not a second hardcoded URL.
- Fallback order on failure: `stable_tag`, then the GitHub Releases API, then the error page. The degraded banner behavior from ticket 002 is unchanged, and its message names which source was used.
- `release.yml` calls `https://purge.jsdelivr.net/gh/rebelribbon/keystone@release/dist/manifest.json` after the force-push to `release`. A failed purge logs a warning and does not fail the release.
- `pickNewestBuildTags_` and its tests stay; the updater's tag picker still uses the GitHub API, which is fine at a handful of owner-initiated calls a week.

**Verify the purge assumption before relying on it.** This is the one unproven part of ADR 0003. Merge a change, then poll the manifest URL and record how long it takes for the new `tag` to appear, with and without the purge call. If purge does not reliably invalidate within the release workflow's lifetime, stop, record it in the Handoff, and the fallback is the service-account Sheet write from the Phase 0 review — which is a new ticket, not an improvisation inside this one.

## Part D — Verification rule in `CLAUDE.md`

Add to the hard rules:

> **Verify from outside.** An acceptance check must observe the outcome from outside the system that produced it. A tool reporting success is not evidence that the thing works. If a ticket adds a URL, the check opens the URL in a browser. If it adds a menu item, the check clicks the menu item. If it adds a deployment, the check loads the deployment. A component's own report of what it did is a log line, not a verification.

This has now cost the project three times: the Sheet menu was broken from ticket 002 until gate 6, hidden because both URLs were reachable by bookmark; ticket 003's load path was quadratic, hidden because gate 3 reported totals and passed; and the test channel has never worked, hidden because gate 6 verified the test/stable split from the updater's own report instead of by opening the URL. Same shape every time.

Audit the existing acceptance history against this rule as part of this ticket and list, in the Handoff, any other check in tickets 001–008 that was satisfied by a self-report rather than an outside observation. Do not fix them here; name them so they can be ticketed.

## Out of scope

- Any engine, scene, or Phase 1 feature work.
- The service-account Sheet write. It is the documented fallback for Part C, not built here.
- Re-litigating `?c=` as the channel mechanism. It works and is not implicated.
- Fixing whatever the Part D audit turns up.

## Acceptance

- [ ] `npm test` and `npm run build` pass.
- [ ] `docs/decisions/0004-test-deployment-finding.md` exists, with the full comparison table and the results of all seven URL cases, whether or not a fix was found.
- [ ] If Part A succeeded: the test deployment URL, opened in a browser signed into multiple Google accounts, renders the Keystone loading screen and then the lot scene. Screenshot in the Handoff showing the address bar.
- [ ] If Part B was taken: the stable URL with `?c=test`, opened in a browser signed into multiple Google accounts, loads the newest `build-*` tag while the bare URL loads `stable_tag`. Both verified by opening them and reading the tag from the page, not from a server log. Screenshots of both in the Handoff.
- [ ] The tag shown on the page matches the newest tag on GitHub within 60 s of a merge, verified by merging a change and watching the page.
- [ ] Purge timing recorded: measured seconds from release-workflow completion to the new `tag` appearing at the manifest URL, with and without the purge call. If purge is unreliable, that is stated plainly and Part C stops at the finding.
- [ ] With the manifest fetch blocked (point `asset_base_url` at a dead host), the page falls back to `stable_tag` and shows the degraded banner naming the source it used.
- [ ] `api.github.com` appears in no code path reachable from `doGet`. A static test asserts it.
- [ ] `CLAUDE.md` contains the verify-from-outside rule.
- [ ] The Handoff lists every acceptance check in tickets 001–008 that was satisfied by a self-report rather than an outside observation.
- [ ] `docs/SETUP.md` matches whichever deployment topology is in force, with no reference to `/dev`.
- [ ] No secrets, no `TODO` in `src/`, no `localStorage`.

## Handoff (Builder fills in)
