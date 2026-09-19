# ADR 0001 — The test channel uses a versioned deployment and an explicit `?c=` parameter

Date: 2026-09-19 · Status: Accepted · Supersedes: SPEC §2.2 (deployment settings) and the channel-detection rule in ticket 002 · Author: Architect

## Context

SPEC §2.2 defined two web app deployments: a test channel on the `/dev` URL, which always runs the latest server code, and a stable channel on a versioned `/exec` URL. Ticket 002 implemented channel detection by checking whether `ScriptApp.getService().getUrl()` ends with `/dev`.

Phase 0 verification found the `/dev` URL unusable. When the owner is signed into more than one Google account, Google rewrites the request path to `/macros/u/N/s/...` and the request never reaches `doGet`. This is Google's behavior, not a bug in our code, and there is no server-side workaround: the failure happens before any script runs. Gates 1, 2, 4, and 5 were therefore all run on the stable channel, and the test channel has never been verified.

Two further problems with the original rule surfaced alongside it:

- Detecting the channel from the service URL is unreliable once Google rewrites paths.
- `ScriptApp.getService().getUrl()` does not reliably distinguish two different versioned deployments of the same project, so the obvious fix — a second `/exec` deployment — cannot be detected the same way.

## Decision

1. The test channel is a second versioned `/exec` deployment. The `/dev` URL is no longer part of the deployment model. It may still be used for ad-hoc debugging in a single-account browser profile, but nothing verifies against it and no documentation directs the owner to it.
2. The channel comes from an explicit query parameter: `?c=test` or `?c=stable`, defaulting to `stable` when absent or unrecognized. The owner bookmarks the test deployment's URL with `?c=test` appended.
3. `?c=` is not owner-restricted. The channel selects only which public jsDelivr bundle the page loads. Both bundles are public artifacts of a public repo, so there is no privilege to protect. `?tag=` and `?dev=` stay owner-only, because they exist for debugging and can point the page at arbitrary tags and internal panels.

## Consequences

- Server code changes now require a new version on both deployments, not just stable. §3.2 previously said the test channel picked up server changes automatically. It no longer does. Server files stay deliberately small and server changes are rare, so the cost is one extra "Manage deployments → edit → new version" click after the ticket-004 updater writes the files.
- Client changes are unaffected. The test deployment still resolves the newest `build-*` tag at request time, so merging a PR still puts new client code on the test URL within a couple of minutes with nobody touching Apps Script. The Phase 0 release gate holds.
- Ticket 002's `resolveChannel_` is replaced, and its owner-only rule for `?channel=` is dropped along with the parameter name. Ticket 003 carries the code change.
- `docs/SETUP.md` changes: the owner creates two versioned deployments rather than one versioned and one `/dev`, and records both URLs, with `?c=test` on the test bookmark.
- Nothing about auth, tag resolution, `asset_base_url`, or `stable_tag` changes.

## Alternatives rejected

- **Keep `/dev` and tell the owner to use a single-account profile.** Rejected: the owner signs into multiple Google accounts as a matter of course, and a deployment model that breaks under normal conditions is not a deployment model.
- **Detect the channel from the deployment ID.** Rejected: Apps Script does not expose the serving deployment's identity to the script in a way that distinguishes two versioned deployments of one project.
- **Append `?authuser=` to the `/dev` bookmark.** Rejected: the index is per-browser-session and changes as accounts are added or removed, so the bookmark silently rots.
