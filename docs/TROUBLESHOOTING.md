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

**Cause.** The service worker can read such a Blob (`arrayBuffer()` returns its bytes and `type` is kept), but IndexedDB refuses to write it. The Blob still refers to the Incognito page's blob data, which the extension's storage does not accept. The opposite direction, a Blob read from the extension's IndexedDB and sent to the agent, restores into the page without trouble. The Blob registry is per browser context (`storage/browser/blob/blob_storage_context.cc:727-738`).

**Solution.** Before writing each part, the background replaces every Blob in it, at any depth, with a copy made from its bytes, keeping its `type` (and a File's `name` and `lastModified`) (`background/workspace/own-blobs.ts`, `own-blobs.test.ts`).

## The PiP window keeps showing a tab that lost the focus

**Symptom.** After the focus moved from a normal window to an Incognito one, the PiP window's Current tab still showed the normal window's tab (`incognito.spec.ts`, "drops closed tabs", 2 of 2 runs).

**Cause.** While it dispatches `windows.onFocusChanged`, Chrome can report both windows as `focused` in `windows.getAll` (2 of 3 probe runs). The tab model took the first, and no later event corrected it.

**Solution.** The tab model takes the window `windows.getLastFocused` names (`tabs/open-tabs.ts`). `incognito.spec.ts --repeat-each=10` then passed 50 of 50.

## A session-control test reads the PiP window's tab as the active one

**Symptom.** `session-control.spec.ts` "closing the PiP window keeps the session…" failed 2 of 20 runs (6 of 40 under a probe) once the recorded tab moved to the managed Incognito window: the active tab id was the PiP window's, not the recorded tab's.

**Cause.** Record posts `open-panel` and then `start-session` focuses the recorded tab. When the PiP window opens after that focus, it keeps the focus, and the test's helper read the tab of the focused window. The product already allows a focused PiP; only the test was wrong.

**Solution.** `watchFocus` and `shownTabId` in `tests/e2e/fixtures/tabs.ts` read the active tab of the browsing window Chrome focused last (`windows.onFocusChanged` order, always-on-top windows skipped). The test then passed 40 of 40 and the spec 90 of 90.

## A new Incognito window can inherit the previous one's data

**Symptom.** None in the tests: 50 resets in a row came back empty. But RECnRun waited only until `cookies.getAllCookieStores()` no longer listed the Incognito store, and the next `windows.create` came 0.4–1.4 ms after that.

**Cause.** The listing drops a store when its last tab closes (`chrome/browser/extensions/api/cookies/cookies_api.cc:895-904`), not when the profile goes. Chrome destroys the off-the-record profile only after its renderers exit, or after a 1 s timeout (`browser_manager_service.cc:145-161`, `profile_destroyer.cc:335-343, 395-411`), and until then `windows.create({ incognito: true })` reuses it with its data (`tabs_api.cc:1044-1047`, `profile_impl.cc:1063-1066`).

**Solution.** RECnRun remembers every Incognito store id it sees (`local:incognito-store-ids`), and before every window creation waits until no Incognito store is listed and `cookies.getAll({ storeId })` rejects with "Invalid cookie store id" for each remembered id, bounded at 10 s (`background/workspace/fresh-window.ts`, `cookie-stores.ts`). The lookup only finds an existing profile (`cookies_helpers.cc:81-98`, `chrome_extensions_browser_client.cc:322-325`), so the rejection means it was erased.

## SameSite=Strict cookies are missing on the released document

**Symptom.** After a start with an identity, the app's first request lacked the restored `SameSite=Strict` cookies; Lax and None ones arrived (`poc-cookies.spec.ts`).

**Cause.** `tabs.update` makes the extension's origin the initiator of the barrier navigation (`tabs_api.cc:2966-2971`), so it is cross-site, and a `tabs.reload` inherits that initiator (`navigation_entry_impl.cc:984`).

**Solution.** The release reloads from inside the barrier's document: `scripting.executeScript` on its `documentId`, isolated world, `location.reload()`. A reload the page starts names the document's origin as initiator (`location.cc:262-272`, `frame_load_request.cc:97-101`), so the request is same-site and carries every restored cookie (`background/workspace/bootstrap.ts`). Only the origin agent runs in the barrier's document, so its missing Strict cookies do not matter.

## Domain cookies are missing from a capture, without an error

**Symptom.** With host permissions for `zephyr-tq.one.be` and `login-acc.one.be` only, a capture held none of the `.one.be` cookies, and nothing failed.

**Cause.** `cookies.getAll` keeps a cookie only with host access to its bare domain as a URL: no port, and `https` only when the cookie is `Secure` (`chrome/browser/extensions/api/cookies/cookies_helpers.cc:51-56, 201-206`, `net/cookies/cookie_util.cc:664-692`). A missing pattern hides the cookie silently. Chrome also treats an unlisted top-level domain such as `localhost` as a one-label registry (`net/base/registry_controlled_domains/registry_controlled_domain.cc:188-195, 308`), so `Domain=app.localhost` is a real domain cookie.

**Solution.** Development builds grant each `RECNRUN_POC_HOSTS` host and every parent domain of two labels or more, both schemes, no port (`cookieHostPatterns` in `config/permissions.ts`). A capture compares the page's `document.cookie` names with the listed cookies and fails with `CookiesNotReadable` naming the missing ones; New identity refuses a cookie host the build cannot read (`CookieHostNotAllowed`). An HttpOnly cookie outside the permissions still cannot be detected.

## The barrier blocks a redirect to a declared sign-in host

**Symptom.** A start of a server-rendered app whose own session had expired failed with `ERR_BLOCKED_BY_CLIENT`, although the identity declared the provider's host and its cookies were restored.

**Cause.** The app answers the barrier navigation with a redirect to its provider, and the barrier blocks every main-frame request off the target origin.

**Solution.** When the identity declares cookie hosts, a fifth tab-scoped rule removes a main-frame `Location` that names one of them, during the barrier only (`background/workspace/barrier.ts`, `declaredLocations`). Chrome applies header changes before it checks for a redirect (`url_request_http_job.cc:1242-1246`), and a response without `Location` is none (`http_response_headers.cc:1099-1112`), so the response commits as the target origin's script-free document and the restore runs. The release reload then follows the app's redirect, now with the provider's cookies. Chrome matches the whole lowercased value with `*` and `?` wildcards (`request_params.cc:70-86`).

## A start fails with `net::ERR_ABORTED` in headed Chromium

**Symptom.** Run through `vp run poc:zephyr`, 5 of 10 starts failed at the `navigate` step with "The page did not load (net::ERR_ABORTED)." Docker's end-to-end runs never hit it.

**Cause.** `windows.create` replies while the new tab's `about:blank` navigation is still running (`chrome/browser/extensions/api/tabs/tabs_api.cc:1306-1311`), and the start navigated the tab before that committed. Where Chromium aborts the later navigation was not found in the source.

**Solution.** `createNeutralWindow` (`background/workspace/windows.ts`) returns once the new tab reports `status: "complete"`, within 5 s, with its listener registered before `tabs.get`. The same probe then opened 6 of 6.
