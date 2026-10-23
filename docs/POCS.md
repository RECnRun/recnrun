# Proofs of concept

Experiments that shaped a durable decision. Each ran on its own local branch with targeted end-to-end tests and a manual check in Chrome; none was merged as is. The decisions they led to live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where the dashboard lives (October 2026)

**Problem.** The website at recnrun.com rendered the user's recordings, so every change to the stored data needed two deploys that had to stay in sync: the website on GitHub Pages and the extension on the Chrome Web Store. A website ahead of or behind the installed extension would show data it could not parse.

**Decision.** The extension owns its UI: `dashboard.html` (POC 1). recnrun.com keeps its address and shows that page in a frame (POC 3). The website only detects the extension and asks to install it when it is missing, so it no longer depends on the data model. POC 2 is the fallback if the frame stops working; POC 4 is deferred.

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

Every POC 1 trigger, plus an "Open RECnRun" item in the page's context menu, opens the dashboard from the tab it came from. On a web page in Chrome 155+, the dashboard opens beside it in a Split View and shows only that site's workspace; on a blank tab, it replaces the tab; anywhere else, and in Chrome without Split View, POC 1's dedicated tab is unchanged. [ARCHITECTURE.md](ARCHITECTURE.md#extension) has the full table.

- **API.** `tabs.create({ url, splitWithTabId, index })` and `tabs.createSplit([a, b])` (Chrome 155+) split tabs; `tabs.unsplit` separates them; `Tab.splitViewId` and `tabs.query({ splitViewId })` (Chrome 140+) read them. `"createSplit" in browser.tabs` detects support, and a rejected split falls back to the dedicated tab, for example when a flag or policy turns Split View off.
- **Findings.**
  - The API has no orientation or size. In Chrome 156 an API split was side by side, two 677 px tabs in a 1,400 px window. Stacked (top and bottom) splits exist only in Chrome's own UI, behind the "Stacked Split Views" flag when this POC ran. `Tab.width` and `Tab.height` report each side's size, and the dashboard sees its own through `window.innerWidth` and `innerHeight`.
  - Reading the page's URL needs `activeTab`, which shows no install warning. A click on the icon, a menu item, or the shortcut grants it for that tab: `tab.url` is set for web pages and missing for a new tab, `about:blank`, and `chrome://` pages alike. Telling those apart would need `tabs` ("Read your browsing history"), so a hidden address counts as a blank tab, and a `chrome://settings` tab is replaced too (Back returns to it).
  - The split dashboard's workspace is fixed when it opens. If the page then moves to another site, following it would need `tabs` or host permissions.
  - The workspace reaches the dashboard as `?workspace=<origin>`, and the dashboard ignores anything that is not an `http`/`https` origin.
  - Playwright can fire the real toolbar action: browser-level CDP `Extensions.triggerAction` on the page's tab target (`Target.getTargets` with `type: "tab"`), reached through `connectOverCDP` on a `--remote-debugging-port`. A page-level CDP session gets "Method not allowed", and a page target gets "Action can only be triggered on a tab target". The action grants `activeTab` as a real click does. The context menus and the shortcut still cannot be fired, so they share the toolbar's handler.
- **To check by hand.** Which layout Chrome gives an API split when the user has stacked splits on.
