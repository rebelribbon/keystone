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

- [x] `npm test` and `npm run build` pass.
- [x] `tests/server-logic.test.js`, using the eval-sandbox harness, covers:
  - cache `get` throws, `Users` tab readable, listed email → `ok`, and the Sheet was actually read;
  - cache `get` throws, `Users` tab readable, unlisted email → `denied`;
  - `Users` tab read throws → `unavailable`, **not** `denied`;
  - cache `put` throws → the request still completes successfully;
  - empty email → `denied`;
  - `unavailable` is never written to the cache;
  - a `denied` entry expires in 30 s and an `ok` entry in 300 s;
  - `decideAccess_` maps all three states correctly.
- [x] A static test asserts no raw `CacheService` reference exists in `src/server/` outside the helpers in `Storage.gs`.
- [x] `tests/transport.test.js`: `AUTH_UNAVAILABLE` is retried once; `ACCESS_DENIED` is not retried.
- [ ] Live: with the `Users` sheet temporarily renamed so the read fails, the deployed URL shows the service-unavailable screen, not the access screen, and an `auth_unavailable` row lands in `Log`. Restoring the name restores access without waiting out a TTL.
- [ ] Live: adding an email to `Users` grants access within 30 s, not 5 minutes.
- [ ] An unlisted account still gets the access screen, unchanged. *(asserted in
  the sandbox by running `doGet`; the live check is step 3 below.)*
- [x] Ticket 005's chunk cache goes through the new helpers, and its eviction-fallback tests still pass.
- [x] No hardcoded emails, no bypass path, no secrets. No `TODO` in `src/`.

## Handoff (Builder fills in)

### The reproduction matches the description

Confirmed before writing code, in the ticket 002 eval sandbox with a
`CacheService` whose `get` and `put` both throw and a `Users` tab listing
`owner@example.com` as `owner`:

- `api_whoami()` → `{"code":"ACCESS_DENIED","message":"This Google account is not on the Keystone access list."}`
- `doGet({})` → the access screen, containing "not on the Keystone access list"
- `Log` → one row: `owner@example.com | access_denied | | reason=not_listed`

Fail-closed on an infrastructure error, exactly as the ticket reads it. The
`getUserRole_` half is the `put` throwing on the write-back after the Sheet read,
so even a cache that only fails writes denied every user. No deviation from the
described shape, so the fix below is the one the ticket specifies.

### What changed

`src/server/Storage.gs`
- `ksCache_` plus `cacheGet_`, `cacheGetAll_`, `cachePut_`, `cachePutAll_`,
  `cacheRemove_`. None throws. `CacheService` appears once in all of
  `src/server/`, inside `ksCache_`, which itself tolerates a failure to acquire
  the cache at all.
- `readUsersRows_`: throws on a missing `Users` tab instead of answering `[]`.
  This is the hinge of the whole ticket — `readSheetRows_`'s empty array is
  indistinguishable from a tab listing other people.
- `getUserRole_` returns the tri-state and never throws. Per-email answers are
  cached: `ok` 300 s (`KS_ROLE_OK_TTL_SECONDS`), `denied` 30 s
  (`KS_ROLE_DENIED_TTL_SECONDS`), `unavailable` never. An empty email is
  `denied` with reason `no_email` and does not read the Sheet.
- `getSettings_` and `invalidateSettings_` go through the helpers.

`src/server/Code.gs`
- `decideAccess_(email, roleResult)` returns `status` alongside `allowed`, with
  code `AUTH_UNAVAILABLE` for `unavailable`. A non-tri-state second argument
  resolves to `unavailable`, never to a denial.
- `doGet` renders `renderUnavailableScreen_` and logs `auth_unavailable` for
  `unavailable`; the `denied` path is untouched.
- `api_getBundle` and `fetchNewestTag_` use the shared helpers and
  `requireAccess_` / `accessError_`.

`src/server/Api.gs`
- `requireAccess_` never converts a failure into a denial; `accessError_` maps a
  refusal to `ACCESS_DENIED` or `AUTH_UNAVAILABLE`; `apiCall_` logs
  `auth_unavailable` on the second.
- Upload and download caches routed through the helpers; `putCacheBatch_`
  removed.

`src/server/Updater.gs`
- The owner gate raises `accessError_`'s code, so the update dialogs say "try
  again", not "you are not on the list".

`src/client/persistence/transport.js`
- `AUTH_UNAVAILABLE` is retried once after `RETRY_DELAY_MS` (1500 ms).
  `ACCESS_DENIED` and every other structured error are surfaced without a retry.

### One judgement call worth flagging: "swallow cache errors" is not a uniform rule

The helpers never propagate — that part **is** uniform, and requirement 1 is
implemented exactly as written. What is not uniform is what a caller does with a
`false` return, and that distinction has to survive this ticket, because
"swallow cache errors" is the sentence someone will remember and apply
everywhere.

**The rule, stated so it can be applied to the next cache:**

> Ask what the cache holds. If losing the value costs *time*, swallow the
> failure and take the slow path. If losing the value costs *data*, report it.

Keystone's script cache is used for both, and the two are easy to confuse
because they run through the same five helpers:

| Cache | What it holds | The slow path when it fails | Therefore |
|---|---|---|---|
| Users answers, `Settings`, tag, bundle chunks | a copy of something the Sheet or the CDN still has | re-read the source | swallow — it is slower, never wrong |
| Download chunks (ticket 005) | a copy of the Drive file's bytes | re-read and re-encode the file | swallow — ticket 005 proves the two paths byte-identical |
| **Upload staging** (`api_beginSave`, `api_saveChunk`) | **the only copy of the build being saved** | **there isn't one** | **report** |

The upload cache is the store for a save in progress (SPEC §14.2: "chunks stored
in `CacheService`, 6 h TTL"), not an optimization over a store. Nothing else has
those bytes: the client has already handed them over, the Drive file is not
written until `api_commitSave` assembles them. A swallowed `put` there does not
make the save slow, it makes the save **silently incomplete** — `api_saveChunk`
answers `{ok: true}`, the client reports a successful save, and the failure
surfaces minutes later as `CHUNK_MISSING` at commit, pointing at the wrong
chunk, for a reason that is no longer on screen. That is the same defect shape
this ticket exists to remove, just moved from the auth path to the save path:
the system reporting something that is not true.

So `api_beginSave` and `api_saveChunk` check `cachePut_`'s return and raise
`CACHE_WRITE_FAILED`. The helper still does not throw; the *caller* decides,
which is the whole reason the helpers return a boolean instead of nothing.

Two things this does **not** license, for whoever reads it next:

- It is not permission to re-raise cache errors on a read path. Every read in
  `src/server/` still treats a failure as a miss, including the upload reads
  (`api_commitSave`'s meta and chunk `get`s), where a miss already has the right
  answer: `UPLOAD_EXPIRED` and "start the save again" are what the person must
  do either way, because the staged bytes are gone.
- It is not a new error code to reach for generally. `CACHE_WRITE_FAILED` means
  "this write was the only copy and it did not land." If a future cache write is
  a copy of something durable, it goes back to the swallowing column.

Requirement 4's "the request still completes successfully" is satisfied where it
was written — the auth path — and the tests assert it there: a throwing `put`
leaves `getUserRole_`, `api_whoami`, and `getSettings_` all working.

### How the owner verifies it on the test URL

1. **The unavailable screen.** In the Keystone Index sheet, rename the `Users`
   tab to `Users_off`. Load the test URL. Expect *"Keystone could not check
   access right now"* — not the access screen, and no mention of the access
   list. The `Log` tab gets one `auth_unavailable` row naming the missing tab.
2. **Restoring it restores access with no TTL wait.** Rename the tab back to
   `Users` and reload. The app loads. Nothing was cached during the outage, so
   there is nothing to wait out.
3. **A denial still looks like a denial.** Open the test URL from a Google
   account that is a Cloud test user but has no `Users` row. Expect the
   unchanged access screen and one `access_denied` row.
4. **30 s, not 5 minutes.** With that same account still denied, add its address
   to `Users` with role `viewer`. Reload after half a minute: it gets in. Before
   this ticket that took five minutes.
5. **The client retry.** Rename `Users` to `Users_off` *while the app is open*,
   then trigger a server call (the build list). The call is retried once about a
   second and a half later, and the second `auth_unavailable` row in `Log` is
   that retry. Rename the tab back and the next call succeeds.

Steps 1–5 are all outside-the-system observations: the browser shows the screen,
the Sheet shows the rows. Nothing here is verified by a tool reporting its own
success.

### Known issues

- `Log` volume during an outage: every refused `api_*` call writes an
  `auth_unavailable` row, and an app in use makes several calls per action. That
  is the ticket's requirement (the distinction has to survive into the Log) and
  the rows are what make an outage legible, but a long outage will be noisy.
- The retry is one attempt, not a backoff. A failure lasting longer than about a
  second and a half still reaches the user — with the right message and a
  working reload, which is the whole point.
- `getSettings_` is unchanged in TTL, per the ticket's out-of-scope list, so a
  cache that fails only on write will re-read the `Settings` tab on every call
  while it is down. Correct, just slower.

