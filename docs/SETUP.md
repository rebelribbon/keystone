# Keystone — one-time setup

Everything here happens in a browser. **No software is installed at any point.**

Do the steps in order. Where a step says *copy the ID*, paste it somewhere
temporary — you will put it into the Settings tab in step 9. Those IDs never go
into this repository; the repo is public.

Budget about 45 minutes the first time. Steps 6b–6f are Google Cloud console
work that only exists because Keystone uses a standard Cloud project (ADR 0002);
they are one-time, and the updater pays them back on every server change after.

---

## 1. Create the index Sheet

1. Go to <https://sheets.new>.
2. Rename it **Keystone Index** (click the title, top left).
3. Create four tabs, named exactly: `Builds`, `Users`, `Settings`, `Log`.
   Rename `Sheet1` to `Builds`, then use the **+** at the bottom left for the rest.
4. Put these header rows in row 1 of each tab, one header per cell (SPEC §14.1).

**`Builds`**

| A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| buildId | name | owner | primaryStyle | levels | estCostLow | estCostHigh | created | updated | driveFileId | thumbFileId | schema | deleted |

**`Users`**

| A | B | C |
|---|---|---|
| email | role | addedOn |

**`Settings`**

| A | B |
|---|---|
| key | value |

**`Log`**

| A | B | C | D | E |
|---|---|---|---|---|
| timestamp | email | action | buildId | detail |

Ticket 002 only reads `Settings` and `Users` and appends to `Log`. `Builds` is
filled in by ticket 003, but create it now so you do this once.

---

## 2. Create the Drive folder

1. Go to <https://drive.google.com>, click **New → New folder**, name it **Keystone Builds**.
2. Open the folder. The URL looks like
   `https://drive.google.com/drive/folders/1AbC...XyZ`.
3. **Copy the ID** — the part after `/folders/`. You need it in step 9.

---

## 3. Open the bound Apps Script project

1. Back in the **Keystone Index** sheet, choose **Extensions → Apps Script**.
2. The script editor opens, bound to the Sheet. Rename the project (top left) to **Keystone**.

Binding it to the Sheet is what makes the `Keystone` menu and the web app share
one project (SPEC §2.2). Do not create a standalone script project.

---

## 4. Get the server files (one time only)

**This is a bootstrap.** From ticket 004 onward, *Keystone → Update server code*
writes these files for you from a release tag. It cannot install itself, so you
paste them by hand exactly once, and never again unless you are recovering.

**Use the newest `build-*` tag.** Tag numbers do not line up with ticket
numbers: the release workflow fires on every push to `main`, including
documentation-only commits, so the counter runs ahead. `build-1`, `build-2`, and
`build-3` contain no server files at all — `dist/server/` 404s on all three,
because the server code did not exist until later.

1. Open <https://github.com/rebelribbon/keystone/releases>. The release at the
   top is the newest; note its tag, for example `build-10`.
2. Confirm that tag actually carries the server files by opening this URL with
   your tag substituted:

   ```
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/appsscript.json
   ```

   You should see JSON starting with `{ "timeZone": ...`. If you get a 404 or a
   "Couldn't find the requested file" page, that tag predates the server code —
   go back a release, or wait for the next one.

3. Open each of these five and copy the whole contents. Replace `build-10` with
   your tag in every URL.

   ```
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/Code.gs
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/Storage.gs
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/Api.gs
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/Updater.gs
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/Index.html
   https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-10/dist/server/appsscript.json
   ```

   If jsDelivr renders a file instead of showing plain text, use
   `https://raw.githubusercontent.com/rebelribbon/keystone/build-10/dist/server/<file>`
   instead — same content, always served raw.

A brand-new tag can take up to a minute to appear on jsDelivr. The release's own
notes list every file it contains, under `server`, so you can check there too.

---

## 5. Create the script files

In the Apps Script editor:

1. The editor starts with a `Code.gs` containing a stub `myFunction`. Select all
   of it and paste in the real `Code.gs`. Save (the disk icon, or Ctrl/Cmd+S).
2. Click **+ → Script** next to *Files*. Name it `Storage` (the editor adds
   `.gs`). Paste in `Storage.gs`. Save.
3. Same again for `Api` and `Updater`.
4. Click **+ → HTML**. Name it `Index` (the editor adds `.html`). Delete the
   starter markup and paste in `Index.html`. Save.

Five files: `Code`, `Storage`, `Api`, `Updater`, `Index`. The names must be
exactly these — `doGet` loads the template by the name `Index`, and the updater
matches files by name when it writes.

---

## 6. Set the manifest

1. Click the gear (**Project Settings**) in the left rail.
2. Tick **Show "appsscript.json" manifest file in editor**.
3. Go back to the editor. Open `appsscript.json`, select all, and paste in the
   `appsscript.json` you copied. Save.

It sets the V8 runtime, the timezone, the seven OAuth scopes, and the web app
access settings (SPEC §2.2, ADR 0002). Nothing else needs those scopes, so do
not add any.

`script.container.ui` is one of them. Without it the **Keystone** menu still
appears, but every menu item fails the moment it opens a dialog with *Specified
permissions are not sufficient to call Ui.showModalDialog*. SPEC §2.2's scope
list does not mention it; see the troubleshooting entry below.

---

## 6b. Create the Cloud project and link the script to it

Every Apps Script project runs against a Google Cloud project. By default that is
a hidden one Google creates for you, with the consent screen pre-filled and every
API the script touches already switched on — which is why none of the next four
steps existed before.

ADR 0002 moved Keystone to a **standard** Cloud project, because the Apps Script
API cannot be used from the default one. A standard project auto-enables nothing.
Everything the hidden project did for you, you now do once, by hand. Skipping any
of steps 6b–6e produces a failure that looks like something else entirely.

1. Go to <https://console.cloud.google.com/projectcreate>.
2. Name it `Keystone`. Create it, then **copy the project number** — the long
   digit string on the project's dashboard, not the project ID.
3. Back in the Apps Script editor: gear (**Project Settings**) → *Google Cloud
   Platform (GCP) Project* → **Change project** → paste the project number →
   **Set project**.

**Changing the Cloud project revokes every existing authorization.** That is
expected. You will re-authorize at step 7.

---

## 6c. Configure the OAuth consent screen

Without this, authorization fails before it starts.

1. In the Cloud console, go to **Google Auth Platform → Branding**.
2. Fill in the app name (`Keystone`), the user support email, and the developer
   contact email. Your own address is fine for both.
3. Save.

You will see *Google hasn't verified this app* when you authorize. That is
correct and expected — it is your own script, used by your own family, and
verification is for apps published to strangers.

---

## 6d. Add every Keystone user as a test user

**This is the step most likely to bite you later, because it fails for other
people and not for you.**

1. **Google Auth Platform → Audience**.
2. Under *Test users*, **+ Add users**.
3. Add your own address **and the address of every family member who will ever
   open Keystone**.

While the app is in Testing mode, an account that is not on this list cannot
authorize it at all. They do not get Keystone's access screen — they get a
Google error before your code runs, so nothing appears in the `Log` tab and
`?dev=gates` has nothing to show.

### Access control is now two lists, and they must agree

| List | Where | What it controls |
|---|---|---|
| **Cloud test users** | Google Auth Platform → Audience | whether Google will let the account authorize the script at all |
| **`Users` tab** | the Keystone Index sheet | whether Keystone lets the account in, and with which role |

Adding someone to one and not the other is a half-grant, and the two halves fail
in completely different ways:

- **In `Users`, not a test user** → a Google authorization error. Your code never
  runs. Nothing is logged.
- **A test user, not in `Users`** → Keystone's own access screen, naming the
  address it saw. This one is logged as `access_denied`.

Adding a family member means both lists, every time. Removing someone means both
lists too.

---

## 6e. Enable the APIs the script calls

A standard Cloud project starts with everything off. Each API is enabled
separately — enabling one does not enable the other.

1. **APIs & Services → Library** in the Cloud console.
2. Search **Apps Script API** → **Enable**. The updater writes the project's
   files and creates versions through it.
3. Search **Google Drive API** → **Enable**. `DriveApp` needs it for build files
   and the updater's backups.

Miss the Drive one and `DriveApp` throws on a folder you can open perfectly well
in a browser, which reads like a wrong folder id and is not. Miss the Apps Script
one and *Update server code* fails with a 403. If either happens, run
**Keystone → Diagnose access…** rather than guessing (step 13).

Any API a future ticket calls has to be enabled here the same way.

---

## 6f. Turn on the Apps Script API for your account

Separate switch from step 6e, and both are required. Step 6e enables the API
**on the Cloud project**; this one enables it **for your Google account**.

1. Go to <https://script.google.com/home/usersettings>.
2. Switch **Google Apps Script API** to **On**.

Per-account, so you do it once no matter how many projects you own. Skipping it
makes *Update server code* fail with a 403 that names this page.

---

## 7. Deploy the test web app

Both channels are **versioned `/exec` deployments** (ADR 0001). The `/dev` URL is
not part of the deployment model: when you are signed into more than one Google
account, Google rewrites the path to `/macros/u/N/s/...` and the request never
reaches the script. Do not use it.

1. **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Fill in:
   - Description: `Keystone test`
   - Execute as: **User accessing the web app**
   - Who has access: **Anyone with a Google account**
4. Click **Deploy**.
5. Authorize when prompted. You will see *Google hasn't verified this app* —
   this is your own script. Click **Advanced → Go to Keystone (unsafe)** and
   **Allow**. Review the scopes; they should be the seven from step 6.
6. Copy the **Web app URL**. It ends in `/exec`. This is your **test URL**.
7. **Copy the deployment ID too.** *Deploy → Manage deployments*, select this
   deployment, and copy the long **Deployment ID** string (it starts `AKfy...`
   and is not the URL). The updater needs it in step 9.
8. **Bookmark the URL with `?c=test` on the end**, like
   `https://script.google.com/macros/s/AKfy.../exec?c=test`. That parameter is
   what makes the page load the newest `build-*` tag instead of `stable_tag`.
   Without it the deployment behaves as another stable one.

---

## 8. Deploy the stable web app

1. **Deploy → New deployment** again, same **Web app** type.
2. Description: `Keystone stable v1`. Same execute-as and access settings.
3. **Deploy**, and copy this URL too. This is your **stable URL**; bookmark it
   as-is, with no `?c=` parameter.
4. Copy this deployment's **Deployment ID** as well, the same way as in step 7.

You now have two `/exec` URLs that look almost identical and differ only in the
deployment id. Label the bookmarks clearly. You record both in Settings in the
next step, which is also what lets the `Keystone` menu show them back to you.

Rolling back later is a Settings change (`stable_tag`), not a redeploy.

Server code changes need a new version on both deployments. **You never create
one by hand** — that is what the updater is for, and it is why the two deployment
IDs go into `Settings` in the next step (ADR 0002). Client changes need nothing
at all: the test deployment resolves the newest `build-*` tag at request time, so
merging a PR puts new client code on the test URL within a couple of minutes.

---

## 9. Fill in the Settings tab

Back in the **Keystone Index** sheet, `Settings` tab. Put the key in column A and
the value in column B, starting at row 2 (row 1 is the `key | value` header).

| key | value |
|---|---|
| `builds_folder_id` | the Drive folder ID from step 2 |
| `github_repo` | `rebelribbon/keystone` |
| `asset_base_url` | `https://cdn.jsdelivr.net/gh/rebelribbon/keystone@{tag}` |
| `stable_tag` | the newest `build-*` tag — the one you verified in step 4 |
| `test_url` | the test deployment's `/exec` URL from step 7, without `?c=test` |
| `stable_url` | the stable deployment's `/exec` URL from step 8 |
| `testDeploymentId` | the test **deployment ID** from step 7 |
| `stableDeploymentId` | the stable **deployment ID** from step 8 |
| `default_units` | `imperial` |
| `region_multiplier` | `1.0` |

Leave `{tag}` in `asset_base_url` exactly as written — the server substitutes the
resolved build tag into it.

`stable_tag` is the tag the **stable** deployment serves, and it must be a tag
that actually carries everything the app loads. Use the same tag you verified in
step 4. If you are filling this in later and no longer have it to hand, check it
the same way — substitute your tag and open:

```
https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-4/dist/server/appsscript.json
```

A 404 means that tag predates the server code; go back to step 4 and pick the
newest release instead.

Do not start this at `build-1`. Early tags are not usable here: `build-1`,
`build-2`, and `build-3` have no `dist/server/`, and `build-1` also predates
`assets/`, so **gate 2 fails against the stable URL at that tag** even though
the cube itself renders.

After this, `stable_tag` is the rollback lever (§3.2): test a new build on the
test URL, then move this one cell to promote it. Changing it is the only step
needed — no redeploy.

Two more keys, `server_tag` and `server_fingerprint`, appear on their own the
first time you run *Update server code*. They record which release the Apps
Script project is running, and `?dev=gates` shows them back to you. Do not fill
them in by hand.

The two `DeploymentId` keys are spelled in camelCase because ticket 004 named
them that way; every other key is snake_case. Copy them exactly as written above.

Optional extra key, only if the test URL will not load bundles from jsDelivr
(see *If the cube does not appear* below):

| key | value |
|---|---|
| `loader_mode` | `cdn` (default) or `inline` |

Settings are cached for 5 minutes, so a change can take that long to take effect.

---

## 10. Add yourself to Users

`Users` tab, row 2:

| email | role | addedOn |
|---|---|---|
| your Google account address | `owner` | today's date |

Use the address of the Google account you will actually browse with. Anyone not
listed here gets the access screen. Add family members later with role `editor`
or `viewer`.

**And add them as Cloud test users at the same time** (step 6d). These are two
separate lists that both have to include a person before they can use Keystone,
and they fail differently when they disagree: missing from `Users` gives them
Keystone's access screen, missing from the test-user list gives them a Google
authorization error before any Keystone code runs at all.

---

## 11. Reload the Sheet to get the menu

Close and reopen the **Keystone Index** sheet. A **Keystone** menu appears next
to *Help*, with four items:

- *Open test URL* and *Open stable URL* — each opens a small dialog with a
  clickable link, because Apps Script cannot retarget the parent tab.
- *Update server code…* and *Promote server code to stable…* — the updater
  (step 13). Both are owner-only; anyone else gets a one-line "owner only" toast.
- *Diagnose access…* — what this script can actually reach, and which OAuth
  scopes were really granted (step 13). Owner-only.

If the menu is missing, the `onOpen` trigger has not run — reload once more.

---

## 12. Check it works

1. **Keystone → Open test URL**, and click the link. The dialog already appends
   `?c=test` for you.
2. You should see the Keystone loading screen list the six bundles, then a lit,
   shadowed, spinning cube.
3. Open the browser console (F12). You should see
   `[KS] boot {tag: "build-5", channel: "test", user: "you@example.com"}`, with
   whatever the newest tag is in place of `build-5`.
4. Now open the **stable** URL the same way. Same cube, but the console should
   report `channel: "stable"` and the tag should be whatever `stable_tag` says.

Seeing the two channels resolve different tags is the check that ADR 0001's
model is working. If both report `stable`, the `?c=test` parameter is missing
from the test bookmark.

To run the Phase 0 gates, append `?dev=gates` (gates 1, 2 and 4) or `?dev=gate3`
(the Drive round-trip) to either URL. Both routes are owner-only. Transcribe the
results into `docs/PHASE0_RESULTS.md`.

`?dev=gates` also prints which server code the project is running, once the
updater has run at least once. Before that it says so plainly rather than
guessing.

`?dev=gate3` writes a real 5 MB build to Drive and then soft-deletes it, so
after a run expect one extra row in `Builds` with `deleted` set, a `.ksb` file
in the `Trash` subfolder, and `save` and `delete` rows in `Log`. That is the
harness cleaning up after itself, not a bug.

---

## 13. From now on: updating the server code

You have pasted the server files once. You never do it again.

**When a release changes anything under `src/server/`:**

1. **Keystone → Update server code…**
2. Pick a tag. The newest is preselected; the one the project is running now
   carries a *running now* badge.
3. **Write to this project.** The updater fetches `dist/server/*` at that tag,
   checks every file's SHA-256 against the release manifest, writes them into
   the Apps Script project, creates a version, and points the **test** deployment
   at it. Takes a few seconds.
4. Test the **test** URL.
5. **Keystone → Promote server code to stable…** when you are happy. It shows
   which version each deployment serves and asks you to confirm by version
   number. It creates nothing; it only moves the version already on test.

Stable keeps serving its old version until step 5. That is the whole point of
having a stable channel, so there is deliberately no way to promote
automatically (ADR 0002).

**The first run after ticket 004 will ask you to authorize again.** ADR 0002
adds the `script.deployments` scope and the fix for the dialog permission error
adds `script.container.ui`, and Google re-prompts whenever the scope list
changes. Everyone else sees the same prompt the next time they open the web
app. It is expected, it is not a failure, and the consent screen will again say
*Google hasn't verified this app* — it is your own script.

### Diagnose access

**Keystone → Diagnose access…** answers "what can this thing actually reach"
without anybody guessing. It reports:

- which account the code runs as, and which is signed in;
- **which OAuth scopes Google actually granted** — read from Google's tokeninfo
  endpoint, not from the manifest. These differ more often than you would
  expect: the manifest says what was *requested*, and on an unverified app the
  consent screen lets a user grant a subset;
- one line per Apps Script service the server depends on: the Settings read,
  Drive in general, the Builds folder specifically, the Apps Script API, and an
  external fetch — each either OK or the verbatim exception.

Read it as measurements, not a verdict. The useful comparisons:

| What you see | What it narrows to |
|---|---|
| *Drive at all* fails **and** *Builds folder* fails | Drive access as a whole — the scope or the account, not the folder id |
| *Drive at all* OK, *Builds folder* fails | that specific folder: wrong id, or this account genuinely cannot open it |
| `drive` absent from *Granted scopes* | the grant, whatever the manifest says |
| *Apps Script API* fails, everything else OK | the API toggle in step 6b, or `script.projects` |

### Restoring after a bad server push

Every run writes a backup of the project's previous contents to the **Keystone
Builds** folder in Drive, named `server-backup-<timestamp>.json`. The ten most
recent are kept.

If an update breaks the test deployment:

1. **Stable is unaffected** until you promote, so there is no emergency.
2. Simplest fix: run *Update server code* again and pick the previous tag. This
   is the normal path and needs nothing from the backup.
3. If the project itself will not run at all — for example the updater got
   partly written and the menu is gone — recover by hand:
   - Open the newest `server-backup-*.json` in Drive (right-click → *Open with →
     Google Docs* renders it as text you can copy).
   - It is a JSON object with a `files` array; each entry has `name`, `type`, and
     `source`.
   - In the Apps Script editor, paste each entry's `source` back into the file
     with the matching `name`, exactly as in steps 5 and 6.
   - Save, then reload the Sheet.

There is no restore button by design: a one-click restore that ran through the
same broken code path is not a recovery path.

---

## If something goes wrong

**A Google Drive error page: "Sorry, unable to open the file at this time."**

You are signed into more than one Google account. Google rewrites the web app
URL from `/macros/s/<id>/exec` to `/macros/u/1/s/<id>/exec` (or `u/2`, and so
on) to pin it to an account, and that rewritten form does not work — Drive
answers instead of the script.

It looks exactly like a broken deployment, but it is not: the request never
reaches your script, so **the Apps Script execution log shows no `doGet` run at
all.** That absence is how you tell this apart from a real server error.

Fix it by making the request come from a browser where the Keystone account is
the default:

- Open the URL in a Chrome profile whose only, or default, account is that one, or
- Open an Incognito window and sign into just that account, or
- Sign out of the other Google accounts and reopen the plain `/exec` URL with no
  `/u/N/` segment in it.

Deleting the `/u/N/` part by hand usually does not stick — Google puts it back.
Changing which account is the default is what actually holds.

**A family member gets a Google error before Keystone loads at all.**
They are not a Cloud test user (step 6d). While the app is in Testing mode Google
refuses the authorization before your code runs, so there is no `Log` row and
nothing to see in `?dev=gates` — the absence of any trace is how you tell this
apart from Keystone's own access screen. Add them under **Google Auth Platform →
Audience**, and check they are in the `Users` tab too.

**"This account does not have access."**
The signed-in address is not in `Users`, or it does not match exactly. The screen
prints the address it saw — compare it with column A. If you are signed into
several Google accounts, check you are in the right one.

**"Keystone is not configured yet."**
The page names the missing `Settings` key. Add it and reload. Remember the
5-minute settings cache.

**A yellow banner about a build tag.**
The release-manifest lookup failed, so the page fell back to `stable_tag`. The
banner says why and names the source it used. The app still works; it is just
not on the newest build.

Since ADR 0003 the newest tag comes from
`{asset_base_url with @release}/dist/manifest.json` on the CDN, not from the
GitHub API. If the banner persists, open that URL in a browser: it should be
JSON whose `tag` is the newest `build-*`. A 404 means the `release` branch or
the purge step is the problem, not your Settings.

**The loading screen stops with a red file.**
That bundle did not load from jsDelivr at that tag. As the owner you get a
*Try the previous build* button. A brand-new tag can take up to a minute to
appear on jsDelivr.

**The cube never appears and no file goes red.**
Apps Script may be blocking external scripts. Set `loader_mode` to `inline` in
`Settings`, wait 5 minutes (or edit any Settings cell to bust the cache), and
reload. The server then fetches the bundles and inlines them. This is slower, so
only use it if `cdn` does not work.

**Nothing changed after a new release.**
The test channel looks up the newest `build-*` tag from the release manifest on
the CDN and caches it for 60 seconds. Wait a minute and reload. If it is still
stale after several minutes, the release workflow's jsDelivr purge step may have
failed — check the workflow run for a warning, and open the manifest URL above
to see which tag it is actually serving. If the change was to server code, a release alone does
nothing — run *Update server code* (step 13).

**"The Apps Script API answered 403."**
The Apps Script API is off for your Google account. Turn it on at
<https://script.google.com/home/usersettings> and run the update again. Nothing
was written, so there is nothing to undo.

**"The Apps Script API answered 401."**
The `script.deployments` scope has not been granted yet. Reload the Sheet, let
the authorization prompt run, and retry.

**"Digest mismatch on …".**
A file fetched from the CDN does not match the SHA-256 the release manifest
recorded for it. The updater aborts before writing anything. Usually it means
jsDelivr is still serving a partly-populated cache for a brand-new tag — wait a
minute and retry. If it persists on a tag that is hours old, do not force it;
that is the check doing its job.

**"The test deployment was NOT repointed."**
`testDeploymentId` is empty in `Settings`. The files and the version were still
written, so fill the key in from *Deploy → Manage deployments* and run the update
again — it is safe to repeat.

**Drive works in the browser but `DriveApp` throws in the script.**
The **Google Drive API** is probably not enabled on the Cloud project (step 6e).
It is a separate switch from the Apps Script API, and a standard Cloud project
enables neither by default — the old hidden project did it silently, which is why
this never happened before ADR 0002. Run **Keystone → Diagnose access…**: if
*Drive at all* fails alongside *Builds folder*, it is the API or the scope, not
the folder id.

**"Specified permissions are not sufficient to call Ui.showModalDialog."**
The manifest is missing `https://www.googleapis.com/auth/script.container.ui`.
Every `Keystone` menu item needs it — the two URL dialogs from ticket 002 as well
as the two updater dialogs. The menu appears without it, which is what makes this
confusing: the scope is only checked when a dialog actually opens. Re-paste
`appsscript.json` from a tag at or after `build-11`, reload the Sheet, and
re-authorize.

**"The Settings key builds\_folder\_id does not name a Drive folder this account
can open."**
That message was wrong and has been removed. A Drive failure now reports the
exception Apps Script actually raised, the id it was given, and which account it
ran as. Run **Keystone → Diagnose access…** before changing anything: if
*Drive at all* fails as well as *Builds folder*, the problem is the `drive`
scope or the account, not the id.

**The Keystone menu shows "owner only".**
Updater items are owner-only. Your row in `Users` has role `editor` or `viewer`,
not `owner`.
