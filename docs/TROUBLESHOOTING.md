# Troubleshooting

Problems we hit, what caused them, and how we solved them. Add an entry when a problem took real investigation, so nobody has to repeat it.

## A click in the dashboard frame reaches the site instead (solved)

**Symptom.** An end-to-end test clicks a button in the dashboard and nothing happens: no PiP window, no session, no error. It fails intermittently, in about one full `vp run test:e2e` out of seven, at a different test each time: Record in `session-control.spec.ts`, New incognito window in `incognito.spec.ts`. Run alone, the same test passes. The Playwright trace reads "element is visible, enabled and stable" and "click action done".

**Cause.** The dashboard is a `chrome-extension://` iframe, so Chromium renders it in another process (an out-of-process iframe). Chromium routes mouse input into such a frame only once it has the frame's hit-test data; until then, it delivers the event to the parent document. Logging `pointerdown` in both documents showed the failing click arrive in the site, with the `IFRAME` element as its target, and never in the dashboard. Playwright checks the click target inside the frame and moves the mouse straight to it, so a click right after the dashboard renders can land before that data exists. A real pointer always moves over the button first, so users are not affected.

Ruled out on the way: a lock request that never settles (the click never reached the dashboard's handler), layout shift from the incognito banner (the failure stayed after the tab list waited for the banner), and `dev-chrome.spec.ts` launching extra browsers (replacing it with a sleep still failed).

**Solution.** `clickInDashboard(locator)` in `tests/e2e/fixtures/session.ts` moves the mouse over the element until a `mousemove` reaches it inside the frame, then clicks. That waits for the condition Chromium needs, as Chromium's own tests do with `WaitForHitTestData`; it retries no click and weakens no assertion. Every click in a dashboard frame goes through it, `clickToOpenPanel` included. With it, 18 full suites in a row lost no click, and the traces show some clicks waiting a few seconds, each a click that would have failed before.

## After two Back steps, a reload shows the wrong route

**Symptom.** `dashboard-frame.spec.ts` "routes deep links…" failed at its last step, rarely (once in 18 full suites): after two `page.goBack()` the dashboard showed "Log in as admin", but after `page.reload()` it showed the list of recordings.

**Cause.** Each popstate sends the route to the frame, and the frame published the route it shows back in a `location` message, which the content script applied with `history.pushState` whenever that path differed from the address bar. Preact publishes in an effect, after paint, so the answer to the first Back (`/`) could arrive after the second Back: the content script pushed `/`, then the second route again, and a reload between those two pushes reloaded `/`.

**Solution.** The frame says which routes come from its own navigation: a link click sends a `navigate` message, the only one the content script turns into `history.pushState`. `location` only sets the title, and only while its path is still in the address bar, so a late answer to a Back changes nothing (`frame.browser.test.tsx`, "a location the address bar has moved past…").

## A captured Blob cannot be written to the extension's IndexedDB

**Symptom.** `poc-transport.spec.ts` failed in `captureIdentity` with `DataError: Failed to write blobs (InvalidBlob)`: a Blob that the origin agent read from an Incognito page's IndexedDB and sent to the service worker over its port (structured clone messaging) could not be stored in the extension's own IndexedDB.

**Cause.** The service worker can read such a Blob (`arrayBuffer()` returns its bytes and `type` is kept), but IndexedDB refuses to write it. The Blob still refers to the Incognito page's blob data, which the extension's storage does not accept. The opposite direction, a Blob read from the extension's IndexedDB and sent to the agent, restores into the page without trouble.

**Solution.** Before writing each part, the background replaces every Blob in it, at any depth, with a copy made from its bytes, keeping its `type` (and a File's `name` and `lastModified`) (`background/workspace/own-blobs.ts`, `own-blobs.test.ts`).
