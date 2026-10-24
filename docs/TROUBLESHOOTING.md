# Troubleshooting

Problems we hit, what caused them, and how we solved them. Add an entry when a problem took real investigation, so nobody has to repeat it.

## A click in the dashboard frame reaches the site instead (solved)

**Symptom.** An end-to-end test clicks a button in the dashboard and nothing happens: no PiP window, no session, no error. It fails intermittently, in about one full `vp run test:e2e` out of seven, at a different test each time: Record in `session-control.spec.ts`, New incognito window in `incognito.spec.ts`. Run alone, the same test passes. The Playwright trace reads "element is visible, enabled and stable" and "click action done".

**Cause.** The dashboard is a `chrome-extension://` iframe, so Chromium renders it in another process (an out-of-process iframe). Chromium routes mouse input into such a frame only once it has the frame's hit-test data; until then, it delivers the event to the parent document. Logging `pointerdown` in both documents showed the failing click arrive in the site, with the `IFRAME` element as its target, and never in the dashboard. Playwright checks the click target inside the frame and moves the mouse straight to it, so a click right after the dashboard renders can land before that data exists. A real pointer always moves over the button first, so users are not affected.

Ruled out on the way: a lock request that never settles (the click never reached the dashboard's handler), layout shift from the incognito banner (the failure stayed after the tab list waited for the banner), and `dev-chrome.spec.ts` launching extra browsers (replacing it with a sleep still failed).

**Solution.** `clickInDashboard(locator)` in `tests/e2e/fixtures/session.ts` moves the mouse over the element until a `mousemove` reaches it inside the frame, then clicks. That waits for the condition Chromium needs, as Chromium's own tests do with `WaitForHitTestData`; it retries no click and weakens no assertion. Every click in a dashboard frame goes through it, `clickToOpenPanel` included. With it, 18 full suites in a row lost no click, and the traces show some clicks waiting a few seconds, each a click that would have failed before.

## After two Back steps, a reload shows the wrong route (open)

**Symptom.** `dashboard-frame.spec.ts` "routes deep links…" fails at its last step, rarely: after two `page.goBack()` the dashboard shows "Log in as admin", but after `page.reload()` it shows the list of recordings.

**Likely cause.** Each popstate sends the route to the frame, and the frame publishes the route it shows back to the content script, which calls `history.pushState` whenever that path differs from the address bar (`content/dashboard-frame.ts`). A late publish of the first Back's route (`/`) arrives after the second Back, so the content script pushes `/` and then the second route again; a reload between those two pushes reloads `/`. Seen before the incognito work, too.

**Next step.** Let the frame say whether a route comes from its own navigation, so the content script pushes only those and never echoes a route the address bar has already moved past. That changes the frame protocol, so it needs its own change and tests.
