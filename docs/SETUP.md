# Keystone — one-time setup

Everything here happens in a browser. **No software is installed at any point.**

Do the steps in order. Where a step says *copy the ID*, paste it somewhere
temporary — you will put it into the Settings tab in step 9. Those IDs never go
into this repository; the repo is public.

Budget about 30 minutes the first time.

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

## 4. Get the server files

Open this URL in a new tab, replacing `build-1` if you are on a newer tag:

```
https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-1/dist/server/
```

You need these four files:

- `Code.gs`
- `Storage.gs`
- `Index.html`
- `appsscript.json`

Open each one directly, for example
`https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-1/dist/server/Code.gs`,
and copy the whole contents.

From ticket 004 onward the *Keystone → Update server code* menu item does this
for you. Until then it is copy and paste.

---

## 5. Create the script files

In the Apps Script editor:

1. The editor starts with a `Code.gs` containing a stub `myFunction`. Select all
   of it and paste in the real `Code.gs`. Save (the disk icon, or Ctrl/Cmd+S).
2. Click **+ → Script** next to *Files*. Name it `Storage` (the editor adds
   `.gs`). Paste in `Storage.gs`. Save.
3. Click **+ → HTML**. Name it `Index` (the editor adds `.html`). Delete the
   starter markup and paste in `Index.html`. Save.

The file names must be exactly `Code`, `Storage`, and `Index` — `doGet` loads the
template by the name `Index`.

---

## 6. Set the manifest

1. Click the gear (**Project Settings**) in the left rail.
2. Tick **Show "appsscript.json" manifest file in editor**.
3. Go back to the editor. Open `appsscript.json`, select all, and paste in the
   `appsscript.json` you copied. Save.

It sets the V8 runtime, the timezone, the five OAuth scopes, and the web app
access settings (SPEC §2.2). Nothing else needs those scopes, so do not add any.

---

## 7. Deploy the test web app

1. **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Fill in:
   - Description: `Keystone test`
   - Execute as: **User accessing the web app**
   - Who has access: **Anyone with a Google account**
4. Click **Deploy**.
5. Authorize when prompted. You will see *Google hasn't verified this app* —
   this is your own script. Click **Advanced → Go to Keystone (unsafe)** and
   **Allow**. Review the scopes; they should be the five from step 6.
6. Copy the **Web app URL**. It ends in `/exec`.
7. **The test URL is that same URL with `/exec` replaced by `/dev`.** Save both.

The `/dev` URL always runs your latest saved code, which is why it is the test
channel. Only you (the script owner) can open `/dev`.

---

## 8. Deploy the stable web app

1. **Deploy → New deployment** again, same **Web app** type.
2. Description: `Keystone stable v1`. Same execute-as and access settings.
3. **Deploy**, and copy this URL too. This is the stable `/exec` URL.

Rolling back later is a Settings change (`stable_tag`), not a redeploy.

---

## 9. Fill in the Settings tab

Back in the **Keystone Index** sheet, `Settings` tab. Put the key in column A and
the value in column B, starting at row 2 (row 1 is the `key | value` header).

| key | value |
|---|---|
| `builds_folder_id` | the Drive folder ID from step 2 |
| `github_repo` | `rebelribbon/keystone` |
| `asset_base_url` | `https://cdn.jsdelivr.net/gh/rebelribbon/keystone@{tag}` |
| `stable_tag` | `build-1` |
| `default_units` | `imperial` |
| `region_multiplier` | `1.0` |

Leave `{tag}` in `asset_base_url` exactly as written — the server substitutes the
resolved build tag into it.

Optional seventh key, only if the test URL will not load bundles from jsDelivr
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

---

## 11. Reload the Sheet to get the menu

Close and reopen the **Keystone Index** sheet. A **Keystone** menu appears next
to *Help*, with *Open test URL* and *Open stable URL*. Each opens a small dialog
with a clickable link, because Apps Script cannot retarget the parent tab.

If the menu is missing, the `onOpen` trigger has not run — reload once more.

---

## 12. Check it works

1. **Keystone → Open test URL**, and click the link.
2. You should see the Keystone loading screen list the six bundles, then a lit,
   shadowed, spinning cube.
3. Open the browser console (F12). You should see
   `[KS] boot {tag: "build-1", channel: "test", user: "you@example.com"}`.

To run the Phase 0 gates, add `?dev=gates` to the test URL. The panel reports
gates 1, 2, and 4; transcribe the results into `docs/PHASE0_RESULTS.md`.

---

## If something goes wrong

**"This account does not have access."**
The signed-in address is not in `Users`, or it does not match exactly. The screen
prints the address it saw — compare it with column A. If you are signed into
several Google accounts, check you are in the right one.

**"Keystone is not configured yet."**
The page names the missing `Settings` key. Add it and reload. Remember the
5-minute settings cache.

**A yellow banner about a build tag.**
The GitHub Releases lookup failed, so the page fell back to `stable_tag`. The
banner says why. The app still works; it is just not on the newest build.

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
The test URL looks up the newest `build-*` tag and caches it for 60 seconds.
Wait a minute and reload.
