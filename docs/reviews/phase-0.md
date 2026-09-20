# Phase 0 review — Foundation

Date: 2026-09-20 · Reviewer: Architect · Verdict: **Approved. Phase 0 is complete.**

## Gates

| Gate | Result | Evidence |
|---|---|---|
| 1. Loader | PASS | First render 109 ms against a 6000 ms budget. Bundles served from jsDelivr at a `build-*` tag. `loader_mode` stayed `cdn`; the `UrlFetchApp` inline fallback was never needed. |
| 2. Texture | PASS | Canvas-generated texture and a jsDelivr-hosted PNG from `assets/` both render. No CORS errors. |
| 3. Round-trip | PASS | 5,242,880 bytes, SHA-256 identical before gzip and after gunzip, through 70 chunks and Drive. |
| 4. Storage | PASS | IndexedDB works inside the deployed HtmlService iframe. The memory fallback for the thumbnail cache is not needed. |
| 5. Release | PASS | Merge to `main` tags `build-N`, publishes `dist/` to the `release` branch, and reaches the test URL with no manual steps. |
| 6. Updater | PASS | `build-12`, 6 files, version 23, 12.2 s. Fingerprint digests verified against the release manifest, so the deployed project runs exactly the bytes CI tagged. |

All six recorded in `docs/PHASE0_RESULTS.md`. Gates 1 through 5 were verified on the stable channel; the test channel was verified at gate 6.

The §16 done-when for this phase — "test URL shows lit cube with shadows from a `build-*` tag; merging a PR updates the test URL with no manual steps; gates recorded" — is met.

## Shipped

Tickets 001 through 006. ADR 0001 (test channel moves off `/dev` to a versioned deployment with an explicit `?c=` parameter) and ADR 0002 (updater creates versions and repoints deployments).

Two defects were found and fixed inside the phase rather than carried forward:

- **005** — `api_loadChunk` re-read and re-encoded the entire build file on every call. 364 MB of work to deliver 5.2 MB, quadratic in build size. Load went from 518.9 s to within range of the save path.
- **006** — a throwing `CacheService` resolved to a denial, so a transient cache failure locked every user out and told them they were not on the access list. Auth is now tri-state, and the cache can no longer answer an authorization question by itself.

Both were the same defect class — treating an infrastructure failure as a real answer — found in two places. That pattern is worth watching for in Phase 1's persistence and content-loading paths.

## Spec amendments

Four divergences surfaced during the phase. The spec is wrong, not the implementation. I am amending SPEC.md as follows; these are Architect edits and no ticket should touch them.

**§2.2, manifest scopes.** The list omits two scopes the implementation requires. Replace the scope line with:

> Manifest scopes: spreadsheets, drive, script.external_request, script.projects (updater), script.deployments (updater, ADR 0002), script.container.ui (Sheet menu dialogs), userinfo.email.

`script.container.ui` is needed by every `Ui.showModalDialog` call. The menu was broken from ticket 002 until gate 6 and went unnoticed because both deployment URLs are reachable by bookmark. That is worth naming as a lesson: the menu had no acceptance check that exercised it, so a broken affordance stayed invisible behind a working workaround.

**§2.2, Cloud project.** Add:

> The script runs on a standard Google Cloud project, not the default one. Setup requires: creating the Cloud project, configuring the OAuth consent screen, adding each family member as a test user, and enabling the Apps Script API and the Drive API separately. `docs/SETUP.md` §6b–6f is the click-by-click procedure.

**§2.2, access control.** Add:

> Access is governed by two lists that must agree: the Cloud project's OAuth test users, and the `Users` tab. An email missing from `Users` gets the Keystone access screen and an `access_denied` row in `Log`. An email missing from the Cloud test users gets a Google consent error before any Keystone code runs, with nothing logged. Adding or removing a person is a single procedure that touches both lists.

**§19, risks.** Add a row:

> | `api.github.com` unauthenticated rate limit (60/hour, shared across Apps Script egress IPs) | Test-channel tag resolution fails | Cache aggressively; fall back to `stable_tag`; see the filed ticket |

## Carried items

Nothing blocks Phase 1. These are open and tracked:

1. **GitHub API rate limit.** Already hit twice. The test channel's tag resolution depends on an unauthenticated endpoint whose quota is shared across Apps Script's egress IPs, so our consumption is not the only thing that can exhaust it. The `stable_tag` fallback and the degraded banner from ticket 002 mean this degrades rather than breaks, which is why it is not a blocker. You have the ticket filed; it should land before Phase 1 ends, because the fix is likely to be "stop asking GitHub at all" — have the release workflow write the newest tag into the `Settings` sheet on publish, and treat the API as the fallback rather than the primary.

2. **The two-list asymmetry is an observability hole.** A family member blocked at the consent screen produces a Google error with nothing in `Log`, so the first signal will be a person telling you it does not work, and nothing on your side to look at. We cannot change Google's error. What we can do is make the procedure single-step in `docs/SETUP.md` and make the failure recognizable, so that "Google error, nothing logged" is documented as meaning "missing from Cloud test users." Worth a doc-only ticket.

3. **Tag numbering drift.** `build-N` tracks workflow runs, including docs commits, so tag numbers and ticket numbers have diverged permanently. Harmless, and renumbering would be worse. The `paths-ignore` change on `release.yml` remains unticketed and optional.

4. **`/dev` is out of the model** per ADR 0001 and should not reappear in documentation.

5. **Phase tag.** Cut `v0.0.0` against the verified build tag when convenient.

## Sign-off

Phase 0 is approved. Phase 1 may begin.
