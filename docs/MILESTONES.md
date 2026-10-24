# Milestones

## M0: Bootstrap, detection, and read-only dashboard

The monorepo, its quality gates, and the first vertical slice: the website detects the extension, and the extension's dashboard shows its recordings in a tab and over recnrun.com.

Acceptance (all automated, run by `vp run verify`):

- [x] Without the extension, the website shows the install banner with a link to the install guide (`tests/e2e/install-banner.spec.ts`).
- [x] With the extension and seeded data, the dashboard shows each recording, newest first, with its start URL, duration, and event count (`tests/e2e/dashboard-frame.spec.ts`).
- [x] With the extension and no data, the dashboard shows an empty state (`tests/e2e/dashboard-frame.spec.ts`).
- [x] Record on a tab in the site's dashboard opens the session in a PiP window and focuses the tab; one dashboard controls it at a time, closing the window or the controlling tab keeps the session for Continue or Stop from any dashboard, closing the recorded tab keeps it too, and only Stop ends it (`tests/e2e/session-control.spec.ts`).
- [x] The toolbar icon does nothing, and the extension has no popup, keyboard commands, or context menu (`tests/e2e/toolbar-action.spec.ts`).
- [x] On the website, the extension covers the page with its dashboard instead of the banner, deep links open a recording, and the dashboard's navigation updates the address bar (`tests/e2e/dashboard-frame.spec.ts`).
- [x] No other origin can frame the dashboard or the session page, and they refuse to render under a foreign ancestor (`tests/e2e/dashboard-embedding.spec.ts`).
- [x] A page on another origin cannot get an answer from the extension by posting bridge messages to the website's window (`tests/e2e/origin-guard.spec.ts`).
- [x] The production build ships a CSP and loads without violations (`tests/e2e/install-banner.spec.ts`).
- [x] The production manifest runs the content script only on `https://recnrun.com/*` asks only for `storage` and `tabs`, and lets only recnrun.com frame `dashboard.html` and `session.html` (`vp run test:extension-manifest`).
- [x] Every gate in [AGENTS.md](../AGENTS.md#rules) runs in `vp run verify`, locally and in CI.

Manual, once per release of the extension:

- [ ] Load `apps/extension/.output/chrome-mv3` unpacked in Chrome, open recnrun.com and `recnrun.com/recordings/<id>`, and see the dashboard; click Record on another tab and see the session float in a PiP window over it; close the window and see Continue on the recorded tab.

## Next

- M1: capture. A spike evaluates rrweb in the extension, then the extension records the current tab's timeline and stores it with its summary ([PRODUCT_BRIEF.md](PRODUCT_BRIEF.md#next)).
- M2: replay a recording.
- M3: extract re-runnable steps from a recording and run them.
- Publish the extension to the Chrome Web Store, and point the install banner at the listing.
