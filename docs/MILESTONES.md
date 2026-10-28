# Milestones

## M0: Bootstrap, detection, and read-only dashboard

The monorepo, its quality gates, and the first vertical slice: the website detects the extension, and the extension's dashboard shows its recordings in a tab and over recnrun.com.

Acceptance (all automated, run by `vp run verify`):

- [x] Without the extension, the website shows the install banner with a link to the install guide (`tests/e2e/install-banner.spec.ts`).
- [x] With the extension and seeded data, the dashboard shows each recording, newest first, with its start URL, duration, and event count (`tests/e2e/dashboard-frame.spec.ts`).
- [x] With the extension and no data, the dashboard shows an empty state (`tests/e2e/dashboard-frame.spec.ts`).
- [x] Record on a tab in the site's dashboard opens the session in a PiP window and focuses the tab; one dashboard controls it at a time, closing the window or the controlling tab keeps the session for Continue or Stop from any dashboard, closing the recorded tab keeps it too, and only Stop ends it (`tests/e2e/session-control.spec.ts`).
- [x] The PiP window shows the current tab apart from the recorded one, and switching tabs never changes the recorded tab; with "Allow in Incognito", the dashboard lists and records incognito tabs, opens an incognito window without starting a session, and stores none of their titles or addresses; without it, it says how to allow it; an incognito recnrun.com tab points to a normal window (`tests/e2e/incognito.spec.ts`).
- [x] Without incognito access, an "Enable Incognito Mode" banner opens RECnRun's details in a focused tab, and flipping "Allow in Incognito" there clears or brings back the banner in every site tab once the user returns to it (`tests/e2e/incognito-access.spec.ts`).
- [x] When RECnRun reloads or turns off, each open site tab replaces its dashboard with a request to reload the page, and opens no PiP window; a sleeping service worker does not trigger it (`tests/e2e/orphaned-tab.spec.ts`).
- [x] The toolbar icon brings the first dashboard tab forward, or opens one in focus when none is open, and the extension has no popup, keyboard commands, or context menu (`tests/e2e/toolbar-action.spec.ts`).
- [x] Installing RECnRun opens the dashboard as the first tab, in focus; a profile reopened with its tabs restored keeps one dashboard, moved first and focused; the first normal window after every other closed gets the dashboard, and another window does not (`tests/e2e/profile-start.spec.ts`).
- [x] While RECnRun is off the toolbar, the dashboard tab asks to pin it from the Extensions menu (`tests/e2e/dashboard-tab.spec.ts`).
- [x] On the website, the extension covers the page with its dashboard instead of the banner, deep links open a recording, and the dashboard's navigation updates the address bar (`tests/e2e/dashboard-frame.spec.ts`).
- [x] No other origin can frame the dashboard or the session page, and they refuse to render under a foreign ancestor (`tests/e2e/dashboard-embedding.spec.ts`).
- [x] A page on another origin cannot get an answer from the extension by posting bridge messages to the website's window (`tests/e2e/origin-guard.spec.ts`).
- [x] The production build ships a CSP and loads without violations (`tests/e2e/install-banner.spec.ts`).
- [x] The production manifest runs the content script only on `https://recnrun.com/*` asks only for `storage` and `tabs`, spans incognito (`incognito: "spanning"`), and lets only recnrun.com frame `dashboard.html` and `session.html` (`vp run test:extension-manifest`).
- [x] Every gate in [AGENTS.md](../AGENTS.md#rules) runs in `vp run verify`, locally and in CI.

Manual, once per release of the extension:

- [ ] Load `apps/extension/.output/chrome-mv3` unpacked in Chrome, open recnrun.com and `recnrun.com/recordings/<id>`, and see the dashboard; click Record on another tab and see the session float in a PiP window over it; close the window and see Continue on the recorded tab. Turn on Developer mode, then "Allow in Incognito" in RECnRun's details (with Developer mode off, Chrome disables an unpacked extension when that toggle reloads it), return to recnrun.com and see the banner gone without reloading it by hand, open a New incognito window from the dashboard, and see it listed; record it and switch between windows to see the PiP window's current tab follow the focus while the recorded tab stays.

## Next

- M1: capture. A spike evaluates rrweb in the extension, then the extension records the current tab's timeline and stores it with its summary ([PRODUCT_BRIEF.md](PRODUCT_BRIEF.md#next)). Its first task gives the background the whole `RecordingSession` lifecycle, controller included, in `storage.session`: pages send `start`, `continue`, `pause`, `stop`, and `release-control` and only read and watch; the worker clears the controller on `tabs.onRemoved` and `tabs.onUpdated(status: loading)` of its tab, and `controlled` derives from the same watch. That deletes `view-locks.ts`, `use-lock-held.ts`, the `BroadcastChannel`, and the `panel-closed` → `return-to-dashboard` chain. Capture must live in the same owner, since a session exists only while capture runs. Accepted when [ARCHITECTURE.md](ARCHITECTURE.md) "Control" describes one owner, `tests/e2e/session-control.spec.ts` passes, and no page imports `navigator.locks`.
- M2: replay a recording.
- M3: extract re-runnable steps from a recording and run them.
- Publish the extension to the Chrome Web Store, and point the install banner at the listing.
