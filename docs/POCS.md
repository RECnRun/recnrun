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

### POC 1: extension dashboard tab

- `dashboard.html` is an extension page; the toolbar popup is gone, so a click on the toolbar icon fires `action.onClicked`.
- Three triggers open it: the toolbar icon, an "Open dashboard" item in the icon's context menu (`contextMenus`, `contexts: ["action"]`), and a command (`Alt+Shift+D`, `MacCtrl+Shift+D` on macOS).
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
