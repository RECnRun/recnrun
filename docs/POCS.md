# Proofs of concept

Experiments that shaped a durable decision. Each ran on its own local branch with targeted end-to-end tests and a manual check in Chrome; none was merged as is. The decisions they led to live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where the dashboard lives (October 2026)

**Problem.** The website at recnrun.com rendered the user's recordings, so every change to the stored data needed two deploys that had to stay in sync: the website on GitHub Pages and the extension on the Chrome Web Store. A website ahead of or behind the installed extension would show data it could not parse.

**Decision.** The extension owns its UI: `dashboard.html` (POC 1). recnrun.com keeps its address and shows that page in a frame (POC 3). The website only detects the extension and asks to install it when it is missing, so it no longer depends on the data model. POC 2 is the fallback if the frame stops working; POC 4 is deferred. The frame went on 2026-10-28: the dashboard became the extension's own top-level tab, which recnrun.com only brings forward ([POC 7](#poc-7-spike-on-the-top-level-dashboard)).

| POC | Branch                    | Idea                                                         | Result                    |
| --- | ------------------------- | ------------------------------------------------------------ | ------------------------- |
| 1   | `poc/extension-dashboard` | A dashboard page inside the extension, opened in a tab       | Adopted                   |
| 2   | `poc/site-redirect`       | recnrun.com redirects the tab to the extension's dashboard   | Works; kept as a fallback |
| 3   | `poc/site-iframe`         | recnrun.com shows the extension's dashboard in a frame       | Adopted                   |
| 4   | `poc/omnibox-rr`          | Type `rr` in the address bar to open or search the dashboard | Works with caveats        |
| 5   | `poc/split-view`          | Open the dashboard beside the current page in a Split View   | Works; see findings       |

### POC 1: extension dashboard tab

- `dashboard.html` is an extension page; the toolbar popup is gone, so a click on the toolbar icon fires `action.onClicked`.
- Three triggers open it: the toolbar icon, a "Dashboard" item in the icon's context menu (`contextMenus`, `contexts: ["action"]`), and a command (`Alt+Shift+D`, `MacCtrl+Shift+D` on macOS).
- An open dashboard tab is focused instead of duplicated. `tabs.query({ url })` finds the extension's own pages without the `tabs` permission.
- **Findings.**
  - `contextMenus` shows no install warning.
  - Chrome silently refused the first shortcut, `Alt+Shift+R`, already taken by the browser.
  - Playwright cannot click the toolbar, menus, or shortcuts, so test builds expose the shared action on the service worker (`recnrunOpenDashboard`).

### POC 2: redirect from recnrun.com

A content script on recnrun.com sends the tab to `chrome-extension://<id>/dashboard.html`, at `document_start`.

| Mechanism                                    | Result                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Background `tabs.update` on the sender's tab | Works with no web-accessible resource and no extension id on the page                            |
| The page navigates itself                    | Blocked without a web-accessible resource: `ERR_BLOCKED_BY_CLIENT`, `chrome-extension://invalid` |
| A declarativeNetRequest redirect rule        | Works without a flash, but needs host permissions                                                |

- **Findings.**
  - The site commits about 18 ms before the redirect, so it flashes.
  - The address bar shows `chrome-extension://…`, not recnrun.com.
  - The Back button returned to recnrun.com and redirected again; checking `PerformanceNavigationTiming.type === "back_forward"` breaks that loop.
  - The background checks the sender's extension id, tab, and URL before redirecting.

### POC 3: dashboard in a frame on recnrun.com

The content script covers the page with a full-viewport `<iframe>` of `dashboard.html` and syncs routes both ways over `postMessage`: deep links like `/recordings/<id>` reach the dashboard, and its navigation updates the address bar and the tab title.

- **Findings.**
  - It works under the production CSP with no website change and no CSP errors. Chrome lets pages frame an extension's web-accessible resources regardless of their CSP; even the site's own script could do it.
  - Framing needs `dashboard.html` as a web-accessible resource. Limiting its `matches` to the content script's origins makes every other origin get `ERR_BLOCKED_BY_CLIENT`.
  - Inside the frame, `storage` and `tabs.create` work as on any extension page.
  - The site cannot read the frame (`contentDocument` is `null`; a `SecurityError` on access), but it sees the frame's `src`, extension id included.
  - recnrun.com framed by another origin could be used for clickjacking, so the dashboard refuses to render when any `location.ancestorOrigins` entry is not an allowed site.
  - Back, Forward, reload, and deep links work.
- **Risks.**
  - The site renders for a moment before the frame mounts.
  - GitHub Pages answers unknown paths with 404, so deep links need a `404.html` copy of `index.html`.
  - Script on the site can send route messages to the frame. It can only navigate the dashboard, never read it.
  - Chrome Web Store review of the web-accessible resource.

### POC 4: `rr` address-bar keyword

`omnibox.keyword: "rr"`, with no extra permission. `rr <text>` suggests up to five matching recordings; choosing one opens it in the dashboard, and free text opens a search.

- **Findings.**
  - Chrome does not fire `omnibox.onInputEntered` for empty input, so `rr` followed by Enter does nothing. The end-to-end test called the handler directly and could not catch this; omnibox tests must go through the real address bar.
  - Suggestions are read asynchronously per keystroke, so an older read can overwrite a newer one ("tes" shown after typing "test"). Drop stale results.
  - Descriptions are XML: an unescaped `<` or `&` in a recording name fails with "Invalid XML".

## The dashboard beside the page (October 2026)

### POC 5: Split View

Every POC 1 trigger, plus an "Open RECnRun" item in the page's context menu, opens the dashboard from the tab it came from. On a web page in Chrome 155+, the dashboard opens beside it in a Split View and shows only that site's workspace; on a blank tab or a browser page, it opens beside it with every workspace (it first replaced the blank tab; see below); anywhere else, and in Chrome without Split View, POC 1's dedicated tab is unchanged. [ARCHITECTURE.md](ARCHITECTURE.md#extension) has the full table.

- **API.** `tabs.create({ url, splitWithTabId, index })` and `tabs.createSplit([a, b])` (Chrome 155+) split tabs; `tabs.unsplit` separates them; `Tab.splitViewId` and `tabs.query({ splitViewId })` (Chrome 140+) read them. `"createSplit" in browser.tabs` detects support, and a rejected split falls back to the dedicated tab, for example when a flag or policy turns Split View off.
- **Findings.**
  - The API has no orientation or size. In Chrome 156 an API split was side by side, two 677 px tabs in a 1,400 px window. Stacked (top and bottom) splits exist only in Chrome's own UI, behind the "Stacked Split Views" flag when this POC ran. `Tab.width` and `Tab.height` report each side's size, and the dashboard sees its own through `window.innerWidth` and `innerHeight`.
  - Dragging the divider shrank the dashboard's pane to about 140 CSS pixels wide side by side, or 64 tall when stacked. Below 30rem in either direction the dashboard tightens its spacing and type, stacks each recording's details, and wraps long hosts and URLs; `tests/e2e/dashboard-compact.spec.ts` checks that 140 px has no sideways scroll and that 64 px still shows the brand and the workspace.
  - Reading the page's URL needs `activeTab`, which shows no install warning. A click on the icon, a menu item, or the shortcut grants it for that tab: `tab.url` is set for web pages and missing for a new tab, `about:blank`, and `chrome://` pages alike. Telling those apart would need `tabs` ("Read your browsing history"), so every hidden address gets the same treatment. At first the dashboard replaced such a tab (a `chrome://settings` tab too, with Back returning to it). Splitting needs no URL: in Chromium 156, `tabs.create({ splitWithTabId })` split `about:blank`, the New Tab page, `chrome://settings`, and `chrome://extensions` alike, so a hidden address now opens the dashboard of every workspace beside it.
  - The split dashboard's workspace is fixed when it opens. If the page then moves to another site, following it would need `tabs` or host permissions.
  - Chrome never shows extension context menu items on its own pages, the New Tab page included; the icon and the shortcut still work there. In a frame, `documentUrlPatterns` matches the frame's URL, so an `http(s)` pattern hid "Open RECnRun" over the dashboard frame on recnrun.com. The item has the `page` and `frame` contexts and no URL patterns.
  - The workspace reaches the dashboard as `?workspace=<origin>`, and the dashboard ignores anything that is not an `http`/`https` origin.
  - Playwright can fire the real toolbar action: browser-level CDP `Extensions.triggerAction` on the page's tab target (`Target.getTargets` with `type: "tab"`), reached through `connectOverCDP` on a `--remote-debugging-port`. A page-level CDP session gets "Method not allowed", and a page target gets "Action can only be triggered on a tab target". The action grants `activeTab` as a real click does. The context menus and the shortcut still cannot be fired, so they share the toolbar's handler.
- **To check by hand.** Which layout Chrome gives an API split when the user has stacked splits on.

## Recording panel in Document Picture-in-Picture (October 2026)

**Problem.** A recording happens in the user's own tab, so its controls (state, elapsed time, Pause, Resume, Stop) must stay visible while another tab has the focus. The implementation plan has the Record click open a [Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture) window, but the dashboard is an extension page: a tab, a Split View pane, or a frame over recnrun.com.

**Result.** Every place the dashboard runs can open the panel in a PiP window. A top-level dashboard opens it itself; framed on recnrun.com it asks the content script, which opens it from the site's top-level page. Every view shows the same recording: the session lives in the extension's session storage, and the dashboard tab, the dashboard frame, and the panel are views of it. The session holds only the state and the clock; capturing events is still to come.

| POC | Branch             | Idea                                                         | Result                |
| --- | ------------------ | ------------------------------------------------------------ | --------------------- |
| 6A  | `poc/document-pip` | The top-level dashboard (tab or Split View) opens the window | Works                 |
| 6B  | `poc/document-pip` | The dashboard framed on recnrun.com opens the window itself  | Refused by Chrome     |
| 6C  | `poc/document-pip` | The framed dashboard asks the site's content script to open  | Works                 |
| 6D  | `poc/document-pip` | No Document PiP API: the controls stay in the tab            | Works; does not float |
| 6E  | `poc/document-pip` | One session in `storage.session` shared by every view        | Works                 |

### POC 6: Record opens a PiP window

The dashboard header has a Record button (`dashboard/panel/RecordControls.tsx`). `start.tsx` picks where the panel goes:

- **Top-level (6A).** The click handler calls `documentPictureInPicture.requestWindow()` before anything awaits, copies the page's stylesheets into the blank window, and renders the panel there with a Preact portal, so the page and the panel share one state and one connection. Closing the window (`pagehide`) keeps recording and offers "Show the panel". Stop closes the window and refocuses the dashboard tab with `tabs.getCurrent`, `tabs.update`, and `windows.update`, which need no permission from an extension page. In a Split View the dashboard steps aside once the window opens: `tabs.unsplit` separates the pair and the page beside it takes the whole window, while the dashboard tab stays open behind it, since closing it would close the window. Stop splits the pair again with `tabs.createSplit` (`dashboard/panel/panel-tab.ts`); if that page is gone, the dashboard just takes the focus.
- **Framed (6C).** The frame posts `open-panel` on the `recnrun-frame` channel; the content script checks the source and origin and opens the window, with a frame of `dashboard.html?view=panel` filling it. Stop posts `close-panel` from that frame, and the content script closes the window.
- **No API (6D).** The panel renders in the tab and says nothing about floating.
- **Shared session (6E).** `storage/recording-session-repository.ts` keeps `RecordingSession` (`recording` or `paused`, the banked milliseconds, and when the current run started) under `session:recording`, validated with `@recnrun/domain` on every read; session storage ends with the browser, as a recording in progress does. Each view reads it, watches it, and writes Start, Pause, Resume, and Stop to it. A view whose panel is elsewhere shows the state and time with "Show the panel" and Stop. When the session ends, from any view, the dashboard tab closes its PiP window and the panel frame posts `close-panel`.
- `tests/e2e/dashboard-split.spec.ts` checks that Record in a split dashboard leaves the page alone in the window and that Stop splits them again. `tests/e2e/record-panel.spec.ts` covers 6A (the window outlives a tab switch, Pause and Resume, Stop refocuses the dashboard tab, closing and reopening the window), 6B, 6C, and 6E (while the dashboard tab is open, the site leaves recording to it, and opening the tab closes the window the site opened).
- **Findings.**
  - A frame gets `NotAllowedError: Opening a PiP window is only allowed from a top-level browsing context`.
  - A click in the dashboard frame also activates the site's top-level page (user activation propagates to ancestors), so the content script can still open the window after the `postMessage` round trip. It works from the content script's isolated world.
  - The PiP document is `about:blank` with the opener's origin. The panel frame inside it reports the site as its only ancestor, so the existing ancestor guard and the `dashboard.html` web-accessible resource cover it: no manifest change.
  - The window outlives its opener tab going to the background, and closes when the opener reloads or navigates, in both 6A and 6C. A recording session must therefore live in the extension, with the panel as one more view of it.
  - In 6C the panel frame and the dashboard frame are separate documents with separate state, so 6E keeps the session in the extension. 6C's Stop cannot refocus the site's tab from the content script; that needs a background message that uses `sender.tab`.
  - Chrome keeps one Document PiP window at a time: opening one from the site closed the one the dashboard tab had open. With the session in the extension, the tab then shows the recording with "Show the panel".
  - Chrome throttles timers in hidden tabs, so elapsed time comes from timestamps, not from counting ticks.
  - Playwright sees the PiP window as a new page (`context.waitForEvent("page")`).
  - Playwright gives every page user activation: `navigator.userActivation.hasBeenActive` is `true` on a fresh page, and `requestWindow()` opens even through CDP `Runtime.evaluate` with `userGesture: false` and after a 6 s wait. Chromium 156 launched without Playwright refuses it on web and extension pages alike (`Document PiP requires user activation`). End-to-end tests cannot catch a lost gesture.
  - Playwright emulates focus, so tests read Chrome's active tab through `tabs.query` in the service worker.
  - One dashboard (October 2026). Chrome keeps one PiP window, so the browser keeps one top-level dashboard. `tabs.unsplit`, `tabs.move` (also across windows), and `tabs.createSplit` move the open dashboard tab beside another page without reloading it, and its PiP window stays open. A `tabs.update` that changes only the URL's hash does not reload the tab either, so a second dashboard tab hands its route to the first and closes. `tests/e2e/dashboard-single.spec.ts` checks both.
  - Session page (October 2026). The one-per-browser rule moved from the dashboard to a new `session.html`, and the dashboard became unlimited (see [Dashboard and session](ARCHITECTURE.md#dashboard-and-session)). The same `tabs` calls now move the session's pane, and a dashboard's PiP window frames `session.html` instead of portalling the panel; `dashboard-single.spec.ts` and `dashboard-split.spec.ts` gave way to `session-split.spec.ts`.
  - Web Locks and `BroadcastChannel` reach every page of the extension origin: the dashboard tab, the dashboard frame over the site, the panel frame inside the site's PiP window, and the service worker. `navigator.locks.query()` tells the service worker whether a panel floats. Views that wait for a lock to free must wait in `shared` mode: exclusive waiters each took the lock in turn and announced themselves as holders.
  - The site as the only way in (October 2026). The Split View pane, the dashboard tab, the toolbar action, the commands, and the context menu items are gone; only the dashboard framed over the site starts a session, in the PiP window the content script opens, and the `recnrun-control` lock names the one dashboard that controls it (see [Dashboard and session](ARCHITECTURE.md#dashboard-and-session)). POC 1 and POC 5 triggers no longer exist.
- **To check by hand** (Chrome, the extension loaded unpacked):
  - Record from the dashboard tab, from a Split View pane, and over recnrun.com (localhost in development) opens a floating window; from a Split View pane, the page beside it fills the window until Stop.
  - The window stays on top after switching to another tab and to another Chrome window.
  - Stop brings back the dashboard tab (6A); note where the focus goes in 6C.
  - Whether `await`ing storage before `requestWindow()` still opens it, which decides whether Record can wait for the extension before opening the window.

## The dashboard as a top-level tab (October 2026)

**Problem.** The framed dashboard cannot show the folder picker or hold Chrome's folder grant, so the cross-profile POC needed a separate folder window and clicks in other profiles. [The plan](dashboard-top-level-plan.md) makes `dashboard.html` the extension's own top-level tab, opened by the toolbar icon and with the profile. Four risks needed an answer first.

**Result.** All four hold. The dashboard needs no orphan handling, and its start-up logic must look at the windows already open instead of waiting for `windows.onCreated`.

### POC 7: spike on the top-level dashboard

A throwaway Playwright spec on a test build that logged the service worker's events (`runtime.onInstalled`, `runtime.onStartup`, `windows.onCreated`) with every tab at that moment into `storage.local`. Not merged.

- **Findings.**
  - **PiP from the dashboard tab works.** `documentPictureInPicture.requestWindow()` in a click opens the window; it is `about:blank` with the extension's origin, and the opener renders into it. The window has no `chrome.runtime`, so everything the panel needs comes from the opener. `pagehide` fires on the opener's reference when the window closes, and the window closes with its opener tab.
  - **Reload and turn-off close the tab.** `runtime.reload()` and `management.setEnabled(id, false)` from `chrome://extensions` both close an open `dashboard.html` tab, so no stale dashboard survives an update or "Allow in Incognito".
  - **A command-line unpacked build reinstalls on every launch.** A persistent context launched twice on one profile with `--load-extension` fires `onInstalled` with reason `install` both times, never `onStartup`. Tests therefore cannot tell install from start-up apart, and the background treats both the same way: make sure the dashboard is the first tab of a normal window.
  - **Restored tabs are there before the worker starts.** With `session.restore_on_startup = 1`, the second launch's worker started with the restored tabs already open, the dashboard at index 1; `windows.onCreated` never fired for that window. Start-up must check the open windows, find the restored dashboard with `runtime.getContexts`, and move it to index 0.
  - **`windows.onCreated` fires for a normal window opened while the profile has none** (only a popup left), with its tab's URL still empty.
  - **A broadcast in flight is lost when the PiP window opens.** A `BroadcastChannel` message posted in the dashboard tab just before `requestWindow()` never reached that tab's own channels; posted before or after, it does. The control lock's announcement hit this, so the dashboard that took the control did not show it, until it announced again once the window opened (found in task 2).
  - **`runtime.getContexts({ contextTypes: ["TAB"] })`** lists the open dashboard tab with `tabId` and `windowId`, and no tab once its window closes.
  - **`action.getUserSettings()`** answers `{ isOnToolbar: false }` in the test browser, so the pin hint is testable.
  - **Not checked here.** Whether focusing the dashboard on every visit to recnrun.com's root is acceptable: that is the user's manual check after task 8.

## Cross-profile control over WebRTC (October 2026)

**Problem.** A developer often tests one application in several Chrome profiles at once (two users, two roles). RECnRun runs once per profile, so each profile has its own dashboard and its own PiP window. The question was whether one dashboard and one PiP window can list and control another profile's tabs with no backend, no helper app, and no STUN or TURN server.

**Result.** It works for two profiles on one machine: one WebRTC DataChannel between the two installations' offscreen documents (`iceServers: []`, host candidates only), paired by copying two codes by hand, or through a folder both profiles choose. The controller lists the other profile's tabs, brings one to the front there, and records, pauses, and stops a session that runs and is stored in the other profile, from its own PiP window. Event capture and Run could not be tried, since neither exists yet. Branch `poc/cross-profile-webrtc-v2` keeps the code, behind development and test builds only, and its `POC-CROSS-PROFILE-WEBRTC.md` has the test report; the design is in [ARCHITECTURE.md](ARCHITECTURE.md#cross-profile-poc-development-and-test-builds-only).

- **Findings.**
  - An MV3 service worker cannot hold an `RTCPeerConnection`; an offscreen document with reason `WEB_RTC` can, and stayed alive through every test. The background stays the one place that decides and stores.
  - The extension id is the same in every profile that loads the same unpacked folder, so each installation generates its own `profileId`.
  - The DTLS certificate fingerprint, pinned at pairing, identifies the peer: the background compares it with the one the handshake proved. A certificate kept in the offscreen document's IndexedDB keeps the fingerprint across restarts.
  - Six digits derived from both fingerprints let both users check, by eye, that nobody swapped a certificate between the two codes.
  - Host candidates connect in about 0.4 s. When the other browser quits, ICE reports `disconnected` after about 7 s. Nothing reconnects by itself: with no signaling channel left, the users pair again.
  - In Docker, Chromium gave the offscreen document plain host candidates (`172.17.0.2`), not mDNS `.local` names, so a pairing code reveals the machine's addresses.
  - The folder picker (`showDirectoryPicker`) must run in a top-level page: the pairing page, not the dashboard frame. Playwright cannot drive the native picker; the end-to-end tests pair by hand, and the folder logic is tested over the origin private file system.
  - A stale offer left on screen while a new one is created is copied, answered, and then refused as an answer to another offer; the pairing page clears the offer and the previous digits before each request.
