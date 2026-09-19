# 006 — Cache failures must not deny access
Phase: 0 (defect) · Tag: normal · Spec sections: §2.2, §14.2, §18 · Relates to: 002, 005

## Goal

A transient `CacheService` failure must never read as "this person is not authorized." Today the auth path treats an exception from the cache the same way it treats a genuine absence of a `Users` row, so a cache that throws locks every user out of the web app, including the owner, and tells them the one thing that is not true: that they are not on the access list.

This is the same class of defect ticket 005 fixed on the load path, where a throwing cache had to be treated as a miss rather than an error. Here the stakes are higher, because the fallback is not slow — it is closed.

**Before starting, confirm the Builder's reproduction matches this description.** If the observed failure differs, say so in the Handoff before writing code; the fix below is shaped around the fail-closed-on-infrastructure-error reading of it.

## The defect

`getUserRole_` and `getSettings_` (ticket 002) read through `CacheService.getScriptCache()`. Neither wraps the call. When `get` throws:

- `getUserRole_` propagates or resolves to no role.
- `decideAccess_` sees no role and returns a denial, which is its correct behavior for an unlisted email and its wrong behavior for an unreadable one.
- `doGet` renders the access screen.
- The owner reads "this account is not on the access list", goes to the `Users` tab, finds their row exactly where it should be, and has nothing to act on.

The same failure hits every `api_*` function in `Api.gs`, which run their own auth check, so the app is not merely unviewable but unusable, and the settings cache is broken at the same moment, so the code path that might have recovered is down too.

## Requirements

### 1. Centralize every cache interaction

Add to `Storage.gs`:

- `cacheGet_(key)` — returns the value, or `null` on a miss **or** on any thrown error.
- `cacheGetAll_(keys)` — same contract, returns a partial object rather than throwing.
- `cachePut_(key, value, ttlSeconds)` — returns `true` on success, `false` on any thrown error. Never propagates.
- `cachePutAll_(obj, ttlSeconds)` — same.
- `cacheRemove_(key)` — same.

No raw `CacheService` reference may remain anywhere else in `src/server/`. Update the ticket 005 chunk-cache calls to go through these helpers. That is a named requirement of this ticket, not a drive-by: the download cache has the same swallow-on-throw need and should not keep its own private version of it.

### 2. Auth resolves to three outcomes, not two

Replace the boolean allow/deny with an explicit tri-state. `getUserRole_` returns one of:

- `{ status: "ok", role }` — the `Users` tab was read and the email matched a row.
- `{ status: "denied" }` — the `Users` tab was read successfully and the email matched nothing. This is a real answer.
- `{ status: "unavailable", reason }` — the `Users` tab could not be read at all. This is not an answer, and must never be rendered as a denial.

`decideAccess_` takes the tri-state and the email and returns the same three outcomes, with an empty email still resolving to `denied` as it does today.

**The cache is never the source of an authorization answer on its own.** On a cache miss or a cache error, read the `Users` tab. Only a successful Sheet read can produce `ok` or `denied`; only a failed Sheet read produces `unavailable`.

### 3. Distinct screen and error code for unavailable

- `doGet` renders a **service-unavailable** screen for `unavailable`: self-contained, inline CSS on the §13.1 tokens like the access screen, saying the app could not verify access right now, to try again in a moment, and showing the reason string small. It does not mention the access list, because that is not what happened.
- Every `api_*` function returns `{ code: "AUTH_UNAVAILABLE", message }`, distinct from `ACCESS_DENIED`. The client's `transport.js` retries `AUTH_UNAVAILABLE` once after a short delay, and surfaces `ACCESS_DENIED` immediately without retrying.
- `unavailable` writes a `Log` row with action `auth_unavailable` and the reason. `denied` keeps logging `access_denied` as it does today. The distinction has to survive into the log, or the next person debugging this reads a wall of denials and reaches the wrong conclusion.

### 4. Negative lookups get a short TTL

Cache `ok` results for 300 s as today. Cache `denied` for 30 s. Never cache `unavailable` at all.

The 300 s negative TTL in the current code means adding someone to the `Users` tab appears not to work for five minutes, which is its own small version of this bug: the owner does the right thing and the system tells them nothing happened.

### 5. No break-glass bypass

Do not add a hardcoded owner email, an environment escape hatch, or any bypass that skips the `Users` check. The repo is public, and the owner is never actually locked away from the Sheet that holds the answer — the failure here is a misleading message and a missing retry, not a lack of access. Fix the message and the retry.

## Out of scope

- Any change to what `denied` means or how the access screen looks.
- Any change to the `Settings` cache TTL, beyond routing it through the new helpers.
- Retry policy anywhere other than `AUTH_UNAVAILABLE`.
- The updater and gate 6 — ticket 004, independent of this.

## Acceptance

- [ ] `npm test` and `npm run build` pass.
- [ ] `tests/server-logic.test.js`, using the eval-sandbox harness, covers:
  - cache `get` throws, `Users` tab readable, listed email → `ok`, and the Sheet was actually read;
  - cache `get` throws, `Users` tab readable, unlisted email → `denied`;
  - `Users` tab read throws → `unavailable`, **not** `denied`;
  - cache `put` throws → the request still completes successfully;
  - empty email → `denied`;
  - `unavailable` is never written to the cache;
  - a `denied` entry expires in 30 s and an `ok` entry in 300 s;
  - `decideAccess_` maps all three states correctly.
- [ ] A static test asserts no raw `CacheService` reference exists in `src/server/` outside the helpers in `Storage.gs`.
- [ ] `tests/transport.test.js`: `AUTH_UNAVAILABLE` is retried once; `ACCESS_DENIED` is not retried.
- [ ] Live: with the `Users` sheet temporarily renamed so the read fails, the deployed URL shows the service-unavailable screen, not the access screen, and an `auth_unavailable` row lands in `Log`. Restoring the name restores access without waiting out a TTL.
- [ ] Live: adding an email to `Users` grants access within 30 s, not 5 minutes.
- [ ] An unlisted account still gets the access screen, unchanged.
- [ ] Ticket 005's chunk cache goes through the new helpers, and its eviction-fallback tests still pass.
- [ ] No hardcoded emails, no bypass path, no secrets. No `TODO` in `src/`.

## Handoff (Builder fills in)
