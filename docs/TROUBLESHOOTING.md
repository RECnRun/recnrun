# Troubleshooting

Problems we hit, what caused them, and how we solved them. Add an entry when a problem took real investigation, so nobody has to repeat it.

## A click in the dashboard frame reaches the site instead (solved)

**Symptom.** An end-to-end test clicks a button in the dashboard and nothing happens: no PiP window, no session, no error. It fails intermittently, in about one full `vp run test:e2e` out of seven, at a different test each time: Record in `session-control.spec.ts`, New incognito window in `incognito.spec.ts`. Run alone, the same test passes. The Playwright trace reads "element is visible, enabled and stable" and "click action done".

**Cause.** The dashboard is a `chrome-extension://` iframe, so Chromium renders it in another process (an out-of-process iframe). Chromium routes mouse input into such a frame only once it has the frame's hit-test data; until then, it delivers the event to the parent document. Logging `pointerdown` in both documents showed the failing click arrive in the site, with the `IFRAME` element as its target, and never in the dashboard. Playwright checks the click target inside the frame and moves the mouse straight to it, so a click right after the dashboard renders can land before that data exists. A real pointer always moves over the button first, so users are not affected.

Ruled out on the way: a lock request that never settles (the click never reached the dashboard's handler), layout shift from the incognito banner (the failure stayed after the tab list waited for the banner), and `dev-chrome.spec.ts` launching extra browsers (replacing it with a sleep still failed).

**Solution.** `clickInFrame(locator)` in `tests/e2e/fixtures/session.ts` moves the mouse over the element until a `mousemove` reaches it inside the frame, then clicks. That waits for the condition Chromium needs, as Chromium's own tests do with `WaitForHitTestData`; it retries no click and weakens no assertion. Every click in a dashboard frame goes through it, `clickToOpenPanel` included. With it, 18 full suites in a row lost no click, and the traces show some clicks waiting a few seconds, each a click that would have failed before.

The session page in a PiP window is such a frame too. A pre-push `vp run verify` lost the Pause click in `session-control.spec.ts`: the trace held every page's frames for about 400 ms, and the PiP window presented its first frame 7 ms after Playwright reported "click action done", so Chromium had no hit-test data for the session frame yet. Clicks in the PiP window now go through `clickInFrame` as well.

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

**Solution.** At first, development builds granted each host the identity declared and its parent domains. Declaring hosts proved unworkable (the user had to know every sign-in provider in advance), so every build now asks for access to all sites (`http://*/*`, `https://*/*`, `config/permissions.ts`) and an identity keeps the whole Incognito cookie store. A capture still compares the page's `document.cookie` names with the listed cookies and fails with `CookiesNotReadable` naming the missing ones, which now only a site the user or a policy blocks can cause (`extensions/common/permissions/permissions_data.cc:391-395, 658-689`). An HttpOnly cookie hidden that way still cannot be detected.

## Withheld Site access hides cookies without an error

**Symptom.** With every build asking for all sites, a capture could still miss cookies, httpOnly ones silently, after the user set RECnRun's Site access to "On click" or "On specific sites" in chrome://extensions.

**Cause.** Withholding Site access removes the hosts from the extension's active permissions (`chrome/browser/extensions/scripting_permissions_modifier.cc:39-58, 183-192`, `permissions_updater.cc:362`), and `cookies.getAll` keeps only cookies of hosts it can access.

**Solution.** The workspace reads `permissions.contains` for both all-sites patterns (`background/workspace/site-access.ts`, `permissions_api.cc:167-188`), refuses every command but Delete with `SiteAccessWithheld` before opening any window, and the panel asks the user to set Site access "On all sites" in RECnRun's details. It reads it again on `permissions.onAdded` and `onRemoved` (`tests/e2e/site-access.spec.ts`).

## The barrier blocks a redirect to a sign-in provider

**Symptom.** A start of a server-rendered app whose own session had expired failed with `ERR_BLOCKED_BY_CLIENT`, although the provider's cookies were restored.

**Cause.** The app answers the barrier navigation with a redirect to its provider, and the barrier blocks every main-frame request off the target origin.

**Solution.** A fifth tab-scoped rule removes a main-frame `Location` that may leave the target origin, during the barrier only (`background/workspace/barrier.ts`): it matches any value with a colon, `//`, a backslash, or a tab, and excludes the origin itself and its paths, queries, and fragments. Chrome applies header changes before it checks for a redirect (`url_request_http_job.cc:1242-1246`), and a response without `Location` is none (`http_response_headers.cc:1099-1112`), so the response commits as the target origin's script-free document and the restore runs. The release reload then follows the app's redirect, now with the provider's cookies. Chrome matches the whole lowercased value with `*` and `?` wildcards (`request_params.cc:70-86`, `base/strings/pattern.cc`); a redirect the patterns miss stays blocked, never followed.

## New identity fails at the navigate step with `net::ERR_INVALID_RESPONSE`

**Symptom.** New identity at a signed-out Gmail address failed with "New identity failed at the navigate step. The page did not load (net::ERR_INVALID_RESPONSE)." The fixture's sign-in redirects, served as `text/html`, never did.

**Cause.** The barrier's hand-over rule removes the `Location` of the 302 to the sign-in origin, so the redirect commits as an ordinary response, and Gmail's carries a type Chrome cannot render. Chrome downloads a response it must download (`Content-Disposition: attachment`) or whose type it does not support (`content/browser/loader/navigation_url_loader_impl.cc:1516-1532`), and a download with a non-2xx status fails the navigation with `ERR_INVALID_RESPONSE` (`IsFailedDownload`, `content/browser/renderer_host/navigation_request.cc:988-991, 5546-5551`).

**Solution.** The barrier's document rule sets `Content-Type` to a plain-text type (`text/x-recnrun-barrier`, next entry) and removes `Content-Disposition` (`background/workspace/barrier.ts`; the hand-over rule did, until the next entry's fix moved it to every barrier document), so the placeholder commits as a plain-text document, which never runs a meta refresh either. A DNR rule that modifies headers counts as an extra-headers listener (`extensions/browser/api/web_request/extension_web_request_event_router.cc:2764-2785`), so the network service applies the change before it derives the response's type. `poc-binary-redirect.spec.ts` covers `application/binary` with and without an attachment.

## A Switch shows the site's sign-in page before the identity opens

**Symptom.** On a Switch to a Gmail identity, the managed tab first showed Google's sign-in page, with its title, then Gmail opened signed in. Users read it as a lost session.

**Cause.** To write a tab's own `sessionStorage` on another origin it visited, the start loads that origin's root in the tab behind the anonymous barrier, which sends no cookie, so the site answers as to anyone signed out. The barrier stops the page's scripts, but Chrome still paints its markup and shows its `<title>`. Helper tabs, reopened layout tabs, and the target origin's own barrier document during `navigate` and `restore` paint the same way.

**Solution.** Every barrier document now commits as `text/x-recnrun-barrier` with `X-Content-Type-Options: nosniff` (the barrier's document rule). Chrome renders any `text/*` type outside a short list of downloads as a plain-text document (`third_party/blink/common/mime_util/mime_util.cc`, `IsSupportedNonImageMimeType`; `third_party/blink/renderer/core/dom/document_init.cc:209-211`), so it has no title and Chrome shows the address instead. The origin agent, which the barrier registers for the origin at `document_start`, hides its document's root (`display: none !important`) when `document.contentType` is that type (`hideBarrierDocument` in `origin/agent.ts`). Chrome runs a `document_start` script synchronously when the document element is created (`extensions/renderer/script_injection.cc:286-300`, `content/renderer/render_frame_impl.cc` `RunScriptsAtDocumentElementAvailable`), so before any paint. No site serves that type, so a page of the origin is never hidden: not a capture's agent, which comes through `scripting.executeScript`, not the release reload, which loads after the barrier is gone, and not a page of the origin that loads in another tab while the barrier is up, which the registered agent also enters. The first version of this fix registered `barrier.css` (`:root { display: none !important; }`) with the agent instead, and Chrome inserts a registered script's CSS into every matching document, with no key to remove it (`extensions/renderer/user_script_injector.cc`, `GetCssSources`), so such a page stayed blank for good, as a layout tab of the same origin still loading when the next tab's barrier went up would. `poc-barrier-hidden.spec.ts` covers both: without the hiding the plain text is painted, without the type the sign-in page is painted with its title, and with the style the other tab is hidden.

## A second tab on an SSO app comes back without its storage

**Symptom.** After a Switch back to an identity, its second tab, a single-page app behind single sign-on (Zephyr), reopened late, and without the state the app keeps in its storage. The identity's row named the app's origin as not saved, or not restored.

**Cause.** The start and the save reach that origin in a helper tab behind the anonymous barrier, which sends no cookie, so the app answers as to anyone signed out and sends the tab to its provider. Behind the barrier that went two ways. A `302` typed `application/binary`, once the barrier removed its `Location`, was a response Chrome downloads, which fails a non-2xx navigation with `ERR_INVALID_RESPONSE` (the entry above), so the visit failed at `navigate` and the row read "(the site did not answer)", and none of the four stores was saved. A `200` page with a `<meta http-equiv="refresh">` to the provider left for it while the agent was writing, so the restore failed at `restore` ("its page did not take its data"), with `localStorage` and `sessionStorage` written but IndexedDB and Cache Storage not. The tab's own `sessionStorage`, restored by the layout, was never at fault, and neither was a plain `302` typed `text/html`. The tab is late because the layout reopens it only once the primary tab is released, after its restore and reload.

**Solution.** The two entries above: a barrier document commits as unsniffed plain text, never a download, and runs no meta refresh. `poc-second-tab-spa.spec.ts` serves the three answers on three origins (`tests/e2e/apps/spa-routes.ts`) and checks that a second tab on each comes back after a Switch with its `localStorage`, `sessionStorage`, IndexedDB, and Cache Storage. Before those fixes the binary origin came back with nothing and the meta-refresh origin without IndexedDB and Cache Storage. Locally the second tab finished loading about 90 ms after the primary tab was released. Reopening it alongside the primary tab's restore would need barriers that can run together (each operation owns one barrier's rule ids and agent script id, and `openBehindBarrier` ends every agent link but its own tab's), and the tab could not load its page before the primary restored the origins they share, so the layout still waits for the release.

## A restored cache entry has an empty `url`

**Symptom.** After a Switch, an app that checks its Cache Storage (Zephyr's `verifyAllCached`) warned that its cached entries had no URL, though each one matched its request and held its body.

**Cause.** The restore wrote each entry as a `Response` it built from the captured status, headers, and body. Chrome stores a cached response's URL list as the response brings it (`content/browser/cache_storage/cache_storage_cache.cc:1913-1914`) and reads it back as stored (`:447-450`), and a constructed `Response` has none, so the entry read back as type `default`, with an empty `url` and `redirected` false. No API sets a response's URL list; only a fetch gives one.

**Solution.** A capture now keeps each response's `type`, `url`, and `redirected` (`OriginData`; an entry saved before reads as `default`, `""`, and `false`). The origin agent fetches a fetched entry again from its request's URL, method, and headers, without cookies (`credentials: "omit"`, so the identity's cookies neither shape the answer nor change) and past the HTTP cache, up to six at a time, and puts that response when its type, final URL, redirect, status, and body match the captured ones (`origin/cache-refetch.ts`). Its headers are the server's current ones, such as `Date`. Otherwise, or when the server does not answer within 10 seconds, the entry goes back as captured, without its URL, and the journal's `rebuilt` names it by cache, method, and URL without its query. An entry the page built itself (`default`) is never fetched. The barrier blocks every subresource of its tab, so it has a rule that lets `xmlhttprequest` requests, the agent's fetches among them, through; its CSP still keeps the site's own scripts from running. `poc-cache-storage.spec.ts` covers a `basic`, a `cors`, and a redirected entry coming back with their URLs, and an entry whose body changed coming back as captured and named. Locally, 200 entries of 100 KB took about 320 ms to fetch, compare, and put, against about 110 ms to put as captured, without the network.

## A start fails with `net::ERR_ABORTED` in headed Chromium

**Symptom.** Run through `vp run poc:zephyr`, 5 of 10 starts failed at the `navigate` step with "The page did not load (net::ERR_ABORTED)." Docker's end-to-end runs never hit it.

**Cause.** `windows.create` replies while the new tab's `about:blank` navigation is still running (`chrome/browser/extensions/api/tabs/tabs_api.cc:1306-1311`), and the start navigated the tab before that committed. Where Chromium aborts the later navigation was not found in the source.

**Solution.** `createNeutralWindow` (`background/workspace/windows.ts`) returns once the new tab reports `status: "complete"`, within 5 s, with its listener registered before `tabs.get`. The same probe then opened 6 of 6.

## History suggestions miss pages visited before today

**Symptom.** The Address field suggested pages from open tabs and saved identities, but from history only pages visited the same day.

**Cause.** `history.search` searches only the last 24 hours unless the call sets `startTime` (`chrome/browser/extensions/api/history/history_api.cc:309, 317-319`).

**Solution.** `dashboard/browser-history.ts` passes `startTime: 0` with the typed text and `maxResults: 20`.

## A visited site that does not answer blocks every Switch

**Symptom.** Once the managed window had shown a site that later stopped answering (a dropped connection, `net::ERR_EMPTY_RESPONSE`), every Switch and Close of that identity failed at the `navigate` step, and so did the start of an identity that had saved the site.

**Cause.** A save reads each site the window showed by loading it in a helper tab; a start restores each one the same way. Any failure ended the command, so one unreachable site held the whole identity hostage.

**Solution.** A save tries the site's root, then once the last page's path the window showed there, and when neither answers keeps the identity's last saved storage of that site, or names it as unsupported when there is none; a start skips the site and the next save keeps its saved storage without visiting it (`background/workspace/origin-reads.ts`, `bootstrap.ts`). The identity's row and the operation journal name each site left out and the step (`tests/e2e/poc-unreachable-origin.spec.ts`).

## A "Leave site?" dialog cancels a Switch

**Symptom.** In the user's run, Gmail asked "Leave site?" when a Switch closed the managed window, and the Switch failed with "Chrome did not close the Incognito windows in time." In tests the dialog is dismissed, which keeps the page, so the close is cancelled the same way (`poc-beforeunload.spec.ts` before the fix: both tests failed after 10 s).

**Cause.** `windows.remove` closes each tab through `ClosePage`, which runs the page's `beforeunload` handler; Chrome shows the dialog once the page has had a user activation.

**Solution.** Before it removes the windows, `closeWindows` (`background/workspace/windows.ts`) discards every tab with `tabs.discard`, which replaces the page without `ClosePage` (`chrome/browser/resource_coordinator/tab_lifecycle_unit.cc:380-415`), so no handler runs. Chrome discards the active tab of the focused window too and answers with a new tab id (`kWebContentsDiscard` is off on desktop, `content/public/common/content_features.cc:381-387`, so the contents are replaced); the tab keeps its session storage, copied by `CopyStateFrom` (`navigation_controller_impl.cc:3032-3049`). RECnRun discards only after the capture read the tab. The page's own `beforeunload` is never patched.

## A save in CI fails with "The page closed before its data was captured."

**Symptom.** On GitHub's runner, `poc-unloaded-tabs.spec.ts` failed in about 50 ms on the Switch right after the test moved the main tab to `about:blank`; local runs passed.

**Cause.** `tabs.update` resolves once the navigation starts, not once it commits, and `tabs.query` already reports the new address as `pendingUrl`. The capture then found the previous page still committed in that tab, took it as the loaded primary tab, and its agent's link closed when `about:blank` committed. A `beforeunload` handler that keeps the page busy for one second reproduces it on any machine.

**Solution.** The `navigateTab` fixture (`tests/e2e/fixtures/tabs.ts`) resolves only once `tabs.onUpdated` reports the tab complete at the new address with no `pendingUrl`, so the session is settled before the test saves it. A user who saves while a tab still loads met the same failure, so a capture now first waits, at most 3 s, until no Incognito tab is loading, and reads a primary tab whose page left during the read behind the barrier instead of failing (`poc-loading-tab.spec.ts`).
