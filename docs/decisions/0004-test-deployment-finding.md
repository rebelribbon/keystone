# ADR 0004 — The test deployment was never broken; the account was

Date: 2026-09-20 · Status: Accepted · Relates to: ADR 0001 (premise marked unsupported), ADR 0002 · Supersedes nothing · Author: Builder, from the owner's Part A investigation

## Finding

**There is no test-deployment defect.** Both deployments are configured
identically and behave identically. Every failure attributed to the test channel
was a Google account authorization failure that would have hit either URL.

Part B is skipped. Both deployments stay.

## Evidence

### The two deployments are the same

| | stable | test |
|---|---|---|
| Deployment type | Web app | Web app |
| Execute as | User accessing | User accessing |
| Who has access | Anyone with a Google account | Anyone with a Google account |
| Version served | 24 | 24 |

Nothing in the configuration differs. The table Part A asked for found no
discrepancy to find.

### Both URLs fail identically in one browser and work identically in the other

| Browser | Stable URL | Test URL |
|---|---|---|
| Signed into the **Workspace** account (`bradly.kerner@principleautomotive.com`) | **fails** | **fails** |
| Signed into the **personal** account | renders the lot scene | renders the lot scene |

The failure is the same in both cases:

- Google rewrites the URL to `script.google.com/a/macros/principleautomotive.com/s/...`
- The page is **"Access blocked: Keystone has not completed the Google
  verification process"**, `Error 403: access_denied`, naming the Workspace
  address.
- Nothing reaches `doGet`, so nothing appears in `Log` or in the Apps Script
  execution list.

### Root cause

The two-list asymmetry named in the Phase 0 review, carried item 2. The
Workspace account is not on the Cloud project's OAuth **test user** list
(Google Auth Platform → Audience, `docs/SETUP.md` step 6d). While the consent
screen is in Testing mode, Google refuses an unlisted account before any
Keystone code runs.

The `/a/macros/<domain>/` rewrite is the tell: that path shape means Google
routed the request through a **Workspace** domain rather than a consumer
account. It is a different rewrite from the `/u/N/` one, and it means something
different.

### Why this went undiagnosed for the whole project

**Every "the test channel is broken" observation was made in the work browser.
Every "stable works" observation was made in the personal browser.** The two
URLs were never opened under the same conditions, so the variable that actually
differed — the signed-in account — was never isolated, and the variable that
appeared to differ — which deployment — never actually did.

The comparison was always deployment-A-in-browser-A against
deployment-B-in-browser-B, and it was read as a difference between deployments.

## What this does and does not establish

**Established.** The test deployment works. The failure is account-scoped, not
deployment-scoped. Adding the Workspace address as a Cloud test user, or using
the personal account, resolves it.

**Not established: that ADR 0001's premise was correct.** ADR 0001 attributed
the `/dev` URL's failure to multi-account path rewriting to `/u/N/`, producing
Drive's *"Sorry, unable to open the file at this time"*. That is **a different
rewrite and a different error** from the one found here:

| | ADR 0001's reported symptom | This finding |
|---|---|---|
| Rewritten path | `/macros/u/1/s/<id>/exec` | `/a/macros/<domain>/s/...` |
| Error | Drive: "Sorry, unable to open the file at this time" | Google: 403 `access_denied`, "has not completed the Google verification process" |
| Cause | multi-account path pinning (asserted) | account absent from the OAuth test-user list (observed) |

So this finding does **not** explain the `/dev` observation, and it does not
disprove it either. It removes the evidence that was later taken to corroborate
it — the "versioned test deployment fails too" observation, which we now know
was the account.

**ADR 0001's stated premise is marked unsupported.** The `/dev` failure was
never isolated the way this one now has been, and it was never retried in the
personal browser. The move to a versioned `/exec` test deployment may still be
right on other grounds — versioned deployments are reproducible, they are what
ADR 0002's updater repoints, and `/dev` always serves head rather than a pinned
version — but "because `/dev` is broken by multi-account rewriting" is not a
claim this project has ever demonstrated.

Whether to re-test `/dev` under controlled conditions is the Architect's call.
Nothing currently depends on the answer.

## Consequences

- Both deployments are kept. Part B of ticket 009 is not taken, and server
  changes keep their pre-production surface.
- `docs/SETUP.md` gains the `/a/macros/<domain>/` signature and its fix.
- Adding a family member is still the two-list procedure from `SETUP.md` step
  6d, and this is the first time that procedure's failure mode has been observed
  on a real account rather than reasoned about.
- ADR 0001's premise line is unsupported. Its decision stands; its stated reason
  should not be cited again as established.

## The lesson, which is not the one already written down

Ticket 009's Part D rule says an acceptance check must observe the outcome from
outside the system that produced it. **Here the outside observation was taken.**
Someone opened both URLs in a browser and watched what happened. It still
produced a confident wrong conclusion, held for the whole project, because the
two observations were made under different conditions and compared as if they
were not.

Observing from outside is necessary and it is not sufficient. When a check
compares two things, the comparison has to change one variable. The rule as
written in `CLAUDE.md` does not say that, and this failure is the most expensive
one the project has had.
