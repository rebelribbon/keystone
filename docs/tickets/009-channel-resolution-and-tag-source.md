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

### Status

**Parts A, C and D are done. Part B is skipped**, because Part A found no
defect to work around.

Part A's finding: **the test deployment was never broken.** Both deployments are
configured identically and behave identically; the failures were a Google
account authorization block that hit either URL. Written up as
`docs/decisions/0004-test-deployment-finding.md` with the evidence.

### Part C — what changed

The newest-tag lookup now reads `{asset_base_url with @release}/dist/manifest.json`
on the CDN. `manifestUrl_` and `tagFromManifest_` are new and pure;
`fetchBuildTags_` is gone from the page-view path.

The tag is **validated** against `build-\d+` before anything uses it. That is not
defensive padding: the string is substituted into every script `src` the page
emits, so a manifest serving `"dev"` or an HTML error body would produce seven
404s and a blank screen instead of a visible failure with a banner.

`resolveRelease_` now returns a `source`, the boot payload carries `tagSource`,
and the banner appends it — so a degraded page says *what it fell back to*
rather than only that something went wrong.

`release.yml` purges the jsDelivr cache for the manifest after the force-push,
with `continue-on-error`. A failed purge means a late tag, which the 60 s cache
and the `stable_tag` fallback both survive; failing a release that is already
built and tagged over it would be worse than the problem.

### A deliberate deviation from ADR 0003 §4

**ADR 0003 §4 keeps the GitHub Releases API as a third fallback inside
`doGet`. I have not implemented that, and the acceptance list agrees with me
rather than with the ADR** — it requires that "`api.github.com` appears in no
code path reachable from `doGet`". The two cannot both hold, so this is a real
contradiction in the ticket and not a reading I can finesse.

I went with the acceptance list, because the fallback cannot help:

- It only fires when the manifest fetch has already failed.
- The manifest is on the same host as every bundle the page loads.
- So in every case where the GitHub fallback would run, the page cannot load its
  bundles anyway. It would resolve a tag for JavaScript that will not arrive.

The only scenario it covers is "the CDN serves `dist/client/*` but not
`dist/manifest.json`", which is not a failure mode jsDelivr has. Against that,
keeping it costs a quota-limited third-party call on the page-view path — the
exact thing ADR 0003 exists to remove.

`pickNewestBuildTags_` and its tests stay untouched, and the updater's tag
picker still uses the GitHub API, as both the ADR and the ticket require.

**For the Architect:** ADR 0003 §4 should be amended to drop the third fallback,
or the acceptance item should be relaxed and I will add it back. I would rather
be told I am wrong than have the two documents disagree in the repo.

### Part D — the audit

The rule is in `CLAUDE.md`. Here is every acceptance check in tickets 001–008
that was satisfied by a self-report rather than an outside observation, or that
was recorded as met against something other than what it named. Not fixed here,
per the ticket.

**Named by ticket 009 already, listed for completeness:**

| Ticket | Check | What actually happened |
|---|---|---|
| 002 | "Opening the test URL as the owner shows the loading screen, then a cube" | Run against **stable**. `PHASE0_RESULTS.md` recorded the substitution afterwards, but the check as written was never met. |
| 002 | "Merging a new PR produces `build-2`, and **the test URL** serves it within two minutes" | Same. This one would have caught the broken test channel in ticket 002. |
| 002 | "Setting `stable_tag` to `build-1` makes stable serve `build-1` **while the test URL serves the newest tag**" | Same — the half that discriminates was never observable. |
| 003 | "**The test deployment**, opened with `?c=test`, loads the newest tag while stable loads `stable_tag`" | Same. Third ticket in a row to carry an unmeetable check as met. |
| 004 | "Immediately after that run, **the test URL** reflects a visible server-side change and the stable URL still shows the old one" | Taken from the updater's completion dialog, which reported `test=repointed`. I wrote that `PHASE0_RESULTS` row; the fingerprint digests I verified prove *which bytes were written*, not *which URL serves them*. |

**Additional ones the ticket did not name:**

| Ticket | Check | Why it is a self-report |
|---|---|---|
| 002 | "`?dev=gates` reports PASS for gates 1, 2 and 4" | `?dev=gates` is Keystone's own code grading Keystone. Gate 2 (texture) and gate 4 (IndexedDB) have no outside observer at all. Gate 1's timing is at least taken from the browser's clock, and the cube was screenshotted, so that one is half-covered. |
| 002 | "Killing the GitHub Releases fetch makes the page fall back to `stable_tag` and show the degraded banner" | I can find no record of this being run live. It was unit-tested. **It is also now obsolete** — ADR 0003 replaced the fetch it describes, and this ticket's equivalent check (dead `asset_base_url`) is likewise still unrun. |
| 003 | "`?dev=gate3` reports PASS with matching SHA-256 digests" | The harness computing the digests is the same code that moved the bytes. This is the exact case the rule names, and it is the one the ticket cites: gate 3 passed while the load path was quadratic. |
| 003 | "Forcing a conflict … produces a `(conflict copy)` build" | The 003 Handoff lists it as optional ("if you want it"). No record of it running. The conflict path has never executed outside a unit test. |
| 004 | "A backup JSON file appears in the Builds folder before each write" | Taken from the dialog's `backup:` line. Nobody has reported opening the Builds folder to see the file. |
| 004 | "only the ten most recent are kept" | Recorded in the 004 Handoff as unverified live — one backup exists. Honest at the time, still unverified. |
| 005 | "Cache hits/misses 70/0" and the per-chunk figures | Counted by our own client code and reported through our own panel. The wall-clock collapse from 518.9 s to 48.3 s is real and externally visible; the hit/miss split is not. |
| 006 | Every acceptance item | **Ticket 006 was never implemented.** The Phase 0 review lists it as shipped and it is not in the repo. Its live checks — renaming the `Users` sheet, adding an email and timing the grant — have never run. This is the strongest instance of the pattern: a whole ticket recorded as done on the strength of a summary. |
| 008 | "`renderCount` stops increasing" | `renderCount` is our own counter. It does detect the failure it exists to detect — a runaway loop increments it — so this is weaker than the others, but it is still our instrumentation reporting on itself. A true outside check is a Chrome trace or a frame-capture count. |
| 008 | Everything | The deployed page was never opened; 008 was verified against a local file-served bundle. Gate 1's new figure on the deployment is unmeasured. |

**The shape, stated once:** in every case the check named an outside observation
and was settled with an inside one, and in every case the substitution happened
because the inside one was available and the outside one was awkward. The rule
in `CLAUDE.md` does not prevent that; what prevents it is the check being
written so it cannot be satisfied any other way — "open the URL and screenshot
the address bar" rather than "the test URL serves the newest tag".

### The strongest case is the one Part A just produced, and the rule does not cover it

Every entry above is "an outside observation was owed and an inside one was
substituted". Part A's finding is worse than that:

**The outside observation was taken. Someone opened both URLs in a browser and
watched what happened. It still produced a confident wrong conclusion, held for
the entire project, across three tickets and two ADRs.**

It failed because the two observations were made under different conditions and
compared as though they were not: every test-URL attempt in the work browser,
every stable-URL attempt in the personal one. One variable appeared to differ
(the deployment). A different one actually did (the signed-in account). The
comparison changed both at once, so it could not have isolated either.

That is a different failure mode from the other fourteen, and it is more
expensive, because "no conclusion" prompts another look while "wrong conclusion"
closes the question. ADR 0001 was written on it, ticket 009 Part B was designed
around it, and three tickets carried an acceptance check that could never pass.

**The rule in `CLAUDE.md` does not catch this.** It is satisfied — the check
observed from outside. I have not amended it, because the wording came from the
Architect verbatim in this ticket and changing it unilaterally would be the
wrong shape of fix for a rule about rigour. The addition I would propose:

> When a check compares two things, change one variable. Two observations made
> under different conditions are not a comparison, whatever they show. Record
> the conditions alongside the result, or the next person cannot tell whether
> they were held constant.

That, not the existing sentence, is what would have caught this in ticket 002.

### Part A — what changed in the docs

- `docs/decisions/0004-test-deployment-finding.md`, with the configuration
  table, the browser-by-browser results, the root cause, and an explicit
  statement of what the evidence does **not** establish.
- `docs/SETUP.md` gains the `/a/macros/<domain>/` signature as its own
  troubleshooting entry, with both fixes, and a line on the existing `/u/N/`
  entry saying the two are different failures with different rewrites — so the
  next person checks the address bar before picking a fix.

**ADR 0001's premise is marked unsupported, not disproven**, and the distinction
is load-bearing. The `/dev` failure was reported as `/u/N/` rewriting plus
Drive's "unable to open the file"; what Part A found is `/a/macros/<domain>/`
plus a 403 `access_denied`. Different rewrite, different error, different cause.
This finding therefore does not explain the `/dev` observation — it only removes
the evidence later taken to corroborate it, namely "the versioned test
deployment fails too", which we now know was the account.

The move to versioned `/exec` deployments still stands on its own merits
(reproducible, pinned, and what ADR 0002's updater repoints). Only the stated
reason is unsupported. Whether to re-test `/dev` under controlled conditions is
the Architect's call; nothing depends on the answer.

### Part C — the purge measurement (ADR 0003's unverified assumption)

The acceptance item, verbatim:

> Purge timing recorded: measured seconds from release-workflow completion to
> the new `tag` appearing at the manifest URL, with and without the purge call.
> If purge is unreliable, that is stated plainly and Part C stops at the
> finding.

**Result: the purge is reliable. It evicts jsDelivr's warm cache for exactly the
purged path, within seconds of the call returning, and nothing else on the same
branch is touched.** Part C does not stop at a finding; the manifest lookup's
freshness guarantee holds.

#### The first attempt, and why it proved nothing

`build-16` was the first release carrying the purge step (workflow run
35527939646). Force-push to `release` completed at **18:05:52.75**; the purge
step ran **18:05:53.81 → 18:05:54.49** and returned HTTP 200 with
`status: "finished"`, `throttled: false`, `providers: {CF: true, FY: true}`; the
job finished at 18:05:56. My fetch at **18:06:11** returned `"tag": "build-16"`
— fresh within 17 s of the release completing.

That observation does not establish that the purge did anything. Every URL I
fetched came back `x-cache: MISS, MISS` — I was hitting a cold jsDelivr edge, so
every request went to origin and returned current content **whether or not the
purge had run**. A cold vantage point cannot distinguish a working purge from a
missing one. My attempted control (an unpurged file on the same branch) was also
fresh, but its prior cache state was unknown, so it was not a control either.

This is Part D's failure mode again, one section after writing it up: the
outside observation was taken, but not under controlled conditions.

#### The measurement that does discriminate

Content identity is irrelevant to the question. The claim under test is
*"`purge.jsdelivr.net` evicts a warm edge entry"*, and that can be measured on
the existing object by watching `age` reset — no release required.

Method: warm the edge by fetching both URLs until they returned
`x-cache: MISS, HIT` (an edge miss served by the Fastly shield) with `age`
climbing 1 s/s; then purge **only** the manifest; then keep polling both.
One variable changed. The control is `dist/server/Code.gs` on the same branch,
warmed the same way, in the same interval, from the same client.

| UTC | manifest (purged) | `Code.gs` (control) |
| --- | --- | --- |
| 18:11:09 | HIT, age 297 | HIT, age 231 |
| 18:11:16 | HIT, age 304 | HIT, age 238 |
| 18:11:26 | HIT, age 314 | — |
| **18:11:41.076** | **purge returns `finished`** | *(not purged)* |
| 18:11:53 | MISS, age 4 | HIT, age 275 |
| 18:11:57 | **age 0** | — |
| 18:12:06 | HIT, age 9 | HIT, age 288 |
| 18:12:15 | HIT, age 18 | — |
| 18:12:19 | HIT, age 22 | HIT, age 301 |
| 18:12:28 | age 39 | HIT, age 310 |

The purged path's age collapses from 314 to 0 across the purge and then climbs
1 s/s from the purge instant. The control's age climbs straight through the same
interval, 275 → 310, and never resets. Both shield POPs serving me (IAD and LGA)
dropped the manifest; neither dropped the control.

What this establishes:

- **The purge works, and is targeted.** A warm entry is gone within seconds of
  the endpoint returning `finished` — at most 7 s in this run, and consistent
  with immediate. The unpurged sibling on the same branch is untouched, so the
  reset is the purge and not a branch-wide or repo-wide event.
- **Without a purge, nothing invalidates it on its own.** jsDelivr serves branch
  URLs with `cache-control: public, max-age=604800, s-maxage=43200` — a 12-hour
  edge lifetime — and the control's age climbed monotonically for over five
  minutes with no revalidation. The stale-manifest risk ADR 0003 names is real,
  not theoretical.
- **`build-16` is consistent with the purge working** and, given the above, is
  now the expected result rather than the evidence for it.

What this does **not** establish, and why it no longer blocks anything: the
end-to-end wall-clock seconds from release completion to a *browser that already
held the old manifest* seeing the new tag. That number needs a client with a
warm edge for this exact URL, which is Brad's browser, not this session. The
eviction is the only step that was in doubt; once the entry is gone the next
fetch is an origin fetch, which `build-16` timed at well under the 60 s
acceptance bound. If the owner wants the end-to-end figure recorded anyway, load
the page, then after the next release reload and read the `tagSource`/tag in the
boot payload — but no decision waits on it.

**For the Architect:** ADR 0003's assumption 3 can be marked verified, with this
section as the evidence. I have not edited the ADR.

### Still open on this ticket

Two live checks for Part C, both of which need the deployment and neither of
which will be ticked from a unit test:

- the merge-to-visible-tag timing (should be inside 60 s);
- the dead-`asset_base_url` fallback showing the banner and naming its source.

The purge measurement is done — see the section above. Neither remaining check
gates anything: the first is a timing figure whose mechanism is now verified,
the second exercises a path with unit coverage.

Run them from the **personal** browser, or add the Workspace address as a Cloud
test user first — which is now a documented step rather than a surprise.
