# ADR 0003 — The newest-tag lookup moves off api.github.com

Date: 2026-09-20 · Status: Accepted · Amends: SPEC §2.2 (test channel tag resolution), §19 · Relates to: ADR 0001 · Author: Architect

## Context

The test channel resolves "newest `build-*` tag" by calling `https://api.github.com/repos/{github_repo}/releases` from Apps Script (ticket 002). That endpoint's unauthenticated quota is 60 requests per hour **per IP**, and Apps Script egress shares its IPs across every script Google runs. We have exhausted it twice without being anywhere near 60 calls of our own. Our consumption is not the variable we control, so caching harder only narrows the window.

The Phase 0 review proposed having the release workflow write the newest tag into the `Settings` sheet on publish. That works, but it requires a Google service account, a key in GitHub Actions secrets, sharing the Sheet with that account, and a rotation burden — a lot of new machinery, and a new credential, for one string.

There is a simpler source. Ticket 001's build already writes `dist/manifest.json` containing the tag, and the release workflow already force-pushes the built tree to the `release` branch. jsDelivr already serves that branch.

## Decision

1. **The newest tag is read from `https://cdn.jsdelivr.net/gh/rebelribbon/keystone@release/dist/manifest.json`**, taking its `tag` field. Cached 60 s, exactly as the GitHub lookup was.

2. **`stable_tag` remains the fallback** when the manifest fetch fails or returns something unparseable, with the existing degraded banner. The failure behavior does not change.

3. **The release workflow purges the jsDelivr cache** for that manifest URL immediately after force-pushing `release`, by calling `https://purge.jsdelivr.net/gh/rebelribbon/keystone@release/dist/manifest.json`. Tag URLs are immutable and cached permanently; branch URLs are not, so without a purge the manifest can serve stale for hours.

4. **The GitHub Releases API is demoted to a second fallback**, tried only if both the manifest fetch and `stable_tag` are unusable. The `pickNewestBuildTags_` helper and its tests stay; the updater's tag picker still uses it, and that runs on deliberate owner action a handful of times a week rather than on every page view.

## Consequences

- No quota, no credential, no service account, no rotation.
- No new failure mode. The page already cannot function if jsDelivr is unreachable, because that is where every bundle comes from. Moving the tag lookup onto the same host adds nothing that was not already a hard dependency.
- One new assumption: that jsDelivr's purge endpoint reliably invalidates the branch URL within the release workflow's lifetime. **This is unverified and ticket 009 verifies it before anything depends on it.** If purge proves unreliable, the fallback is the Phase 0 review's service-account Sheet write, and this ADR gets superseded rather than patched.
- §19's risk row for the GitHub rate limit narrows to the updater's tag picker only.

## Alternatives rejected

- **Service account writes the tag into `Settings` on publish.** Kept as the documented fallback. Rejected as the primary because it introduces a credential and a rotation burden to move one string.
- **Cache the GitHub response for hours instead of 60 s.** Rejected: it lengthens the window in which a merged PR is invisible on the test channel, which is the one thing the test channel exists to do, and it still fails when the shared quota is already exhausted at the moment the cache expires.
- **Authenticate the GitHub call with a token.** Rejected: a token in a public repo's runtime path, for a public read, to work around a quota we can avoid entirely.
