# Plan: the dashboard as a top-level extension tab

Branch `dashboard-top-level`, from `master` at `44c154d`. Decided by the user on 2026-10-28.

## Goal

The dashboard is the extension's own tab, `chrome-extension://<id>/dashboard.html`, never framed. recnrun.com becomes documentation and a way to the dashboard. The toolbar icon opens the dashboard or brings an open one forward, and a profile opens with the dashboard in its first tab, focused.

The reason is the cross-profile POC: a framed page cannot show the folder picker or hold Chrome's folder grant, which forced a separate folder window and clicks in other profiles. A top-level dashboard that opens with the profile keeps the grant alive. The POC moves onto this branch afterwards (Next, below).

## Decisions

- **No frame.** `dashboard.html` renders only top-level. The content script stays only as the bridge host: no dashboard frame, no PiP window opened from the site, no orphan watch, no incognito notice. `web_accessible_resources` goes, so no page can frame or load any extension page.
- **Routes in the hash.** `dashboard.html#/recordings/<id>`. The extension serves files by path, so a path route would not survive a reload. Back, Forward, and reload work through `hashchange`, and the dashboard sets `document.title` itself.
- **The PiP window opens from the dashboard.** Record takes the control lock and calls `documentPictureInPicture.requestWindow()` in the click, then renders the session into that window directly: the window is of the extension's own origin, so it needs no frame. When the window closes (`pagehide`), the lock frees and the background focuses the dashboard's own tab. Closing the dashboard tab closes its PiP window, as closing the site tab does today.
- **The toolbar icon.** `action.onClicked` focuses the first dashboard tab and its window, found with `tabs.query`, which sees a tab still loading through `pendingUrl`, so a second click finds the tab the first one opened. "First" means the lowest window id, then the lowest tab index. With no dashboard open, it opens one in the clicked window, or, from an incognito window, in the last focused normal window, or in a new one: in spanning mode, extension pages do not open in incognito windows.
- **Opening with the profile.** On `runtime.onInstalled`, `runtime.onStartup`, and `windows.onCreated` for a normal window when the profile has no other normal window, the background makes sure that window's first tab is the dashboard and focuses it. A dashboard tab Chrome restored is moved to index 0, not duplicated. On start-up the background checks the windows already open, since Chrome restores them before the worker starts (POC 7). A new window while another is open (Ctrl+N) gets none (the user's choice).
- **"Pin to toolbar" cannot be set.** Chrome has no API for it; only the enterprise policy `toolbar_pin` can. The dashboard reads `action.getUserSettings().isOnToolbar` and, while false, shows a short hint: open the Extensions menu and pin RECnRun. `action.onUserSettingsChanged` hides it once pinned.
- **The site.** It no longer covers itself with anything. With the extension installed, the root page sends a new bridge request, `open-dashboard`, once on load, and keeps showing the documentation with an **Open dashboard** button that sends it again (the user's choice: open and show the docs). Other pages, such as the privacy policy, never send it. Without the extension, the install banner stays. `open-dashboard` has no fields and returns `{}`. It widens the security model only by letting recnrun.com focus or open the dashboard tab, which shows nothing to the site.
- **No deep links on the site.** `recnrun.com/recordings/<id>` goes, and so does the build's `404.html` copy: routes live in the dashboard's hash.
- **Permissions stay `storage` and `tabs`.** `action` and `windows` need none.

## Risks to check first

The spike (task 1) answers these before any product change:

1. Document PiP opened by a `chrome-extension://` tab: user activation from the click, rendering into the window, and closing with the opener.
2. What Chrome does to an open dashboard tab when RECnRun reloads (an update, "Allow in Incognito") or turns off. If the tab closes or goes blank with no event, the dashboard needs no orphan handling at all; if it stays stale, the plan gains a task.
3. `runtime.onStartup` and `windows.onCreated` order against Chrome's session restore, under a persistent Playwright context launched twice on one profile.
4. Whether focusing the dashboard on every visit to recnrun.com's root is acceptable once seen; if not, the button alone remains.

## Tasks

Each task is one commit with `Red:` and `Green:` lines where behavior changes, updates the docs it changes (`PRODUCT_BRIEF.md`, `ARCHITECTURE.md`, `MILESTONES.md`, the security model), and `vp run verify` exits 0 before the next one starts.

1. **Spike.** Throwaway end-to-end checks for the four risks above. Findings go to `docs/POCS.md`; no product code. Done: [POC 7](POCS.md#poc-7-spike-on-the-top-level-dashboard).
2. **Top-level dashboard with a hash router.** `dashboard.html` opened on its own renders the dashboard instead of pointing to recnrun.com. The framed path still works, so the change is additive. Unit tests for the hash router and a component test for the top-level start. Landed with task 3 in one commit: Record on a dashboard tab needs its own PiP window.
3. **PiP from the dashboard.** The control lock, `requestWindow` in the click, the session rendered into the window, and the lock released and the dashboard tab focused on `pagehide`. `dashboard-tab.spec.ts` covers it; `session-control.spec.ts` moves over in task 6.
4. **Toolbar icon, install, and profile start.** The background's opener and its tests; `toolbar-action.spec.ts` changes from "does nothing" to "opens or focuses"; a new spec launches the persistent context twice and finds the dashboard first and focused; the pin hint and its component test. Landed in two commits, the opener first and the pin hint second. The dashboard opened on install made the end-to-end specs that opened their own dashboard tab use that one instead (`installedDashboard` in `tests/e2e/fixtures/tabs.ts`).
5. **`open-dashboard` and the website.** The bridge request through the `adding-a-bridge-message` skill, the content script forwarding it, and the website's root sending it with an **Open dashboard** button. `install-banner.spec.ts` and a new site spec. The button's end-to-end click waits for task 7: until then the dashboard frame covers the root and takes the click.
6. **End-to-end tests on the dashboard tab.** The fixtures open `dashboard.html` instead of reading the site's frame, and every spec that reads the dashboard moves over. Tests only, while the frame still exists. Done: `session-control`, `incognito`, and `incognito-access` run on dashboard tabs, and `dashboard-tab.spec.ts` took the recordings, empty, and unreadable states from `dashboard-frame.spec.ts`, whose Record and PiP cases `session-control` now covers. Flipping "Allow in Incognito" reloads RECnRun, which closes its dashboard tabs; `runtime.onInstalled` fires and opens one again. Two dashboards racing for the control need their clicks scheduled for one moment from inside each page: a click Playwright sends to the second tab lands after the lock's broadcast, so it never races. What stays on the site (the frame, deep links, the orphan notice, the incognito notice, embedding) goes in task 7.
7. **Remove the frame.** `content/{dashboard-frame,panel-window,site-session,orphan-watch,notice}.ts`, `messaging/{frame-protocol,frame-channel,site-port}.ts`, `ports/site-port.ts`, `dashboard/site-ports.ts`, `dashboard/router.ts`'s frame router, `views/{framed.tsx,Refusal.tsx}`, `session.html` if task 3 made it unused, the embedding checks in `config/origins.ts`, `web_accessible_resources`, and the `404.html` copy. `dashboard-embedding.spec.ts` becomes a check that no page can load an extension page; `orphaned-tab.spec.ts` follows the spike's finding. `site-open-dashboard.spec.ts` gains the **Open dashboard** click, which the frame blocked in task 5. The manifest guard asserts no `web_accessible_resources`, and `.dependency-cruiser.cjs` loses the rules for the removed folders, with the reason in `ARCHITECTURE.md`.
8. **Docs and rules.** `AGENTS.md`'s first paragraph, `.claude/rules/extension.md` and `website.md` (then confirm Codex loads them), `MILESTONES.md`'s M0 items and manual check, and this plan's results.

## Next: the cross-profile POC on this branch

Once this lands, the POC stack (`poc/cross-profile-webrtc-v2`, `poc/dashboard-only-pairing`, `poc/multi-profile-mesh`) is rebased onto it:

- The folder picker runs in the dashboard, and `folder.html` and its window go.
- The grant lasts while any dashboard tab is open, and the dashboard opens with the profile, so a profile's linked peers usually read the folder and find a newcomer with no click; the mesh relay covers profiles whose dashboard is closed.
- After the first restart, Chrome asks again in the dashboard (H1): **Allow folder**, then **Allow on every visit**, once.
- The e2e runs five profiles, each setting up the folder only in its own dashboard.

## Manual check for the user

In branded Chrome, after task 8:

1. Install the unpacked build and see the dashboard open in a focused tab.
2. Close every window of the profile and open it again: the dashboard is the first tab, focused.
3. Click the toolbar icon with the dashboard in another window, and with none open.
4. Open recnrun.com (or the dev site): the dashboard comes forward, and the site still shows its docs.
5. Record a tab and see the session float; close the dashboard tab and see the window close while the session keeps running.
