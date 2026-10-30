# RECnRun — POC results: Single-tab multi-user sessions

Branch `poc/single-tab-multi-user`, based on `poc/tab-group-containers` (`d150bf6`, [its report](poc-tab-group-containers-results.md)). The lab is the same unpacked MV3 extension under `scripts/containers-lab/`, extended with a session manager; nothing under `apps/` or `packages/` changed, and the production manifest guard still passes.

**Scope.** Save and restore each identity's data (HTTP cookies, HttpOnly included, `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, CacheStorage, OPFS) across switches in one tab, with a new document on every switch. Isolating the network, service workers, and other workers is out of scope: the lab's debugger interception and prelude are used here as the mechanism that keeps one jar and one storage namespace per identity, not as a security boundary.

**Verdict: PASS** for that scope, in two modes of the same session manager. The **debugger** mode keeps the tab-group lab's mechanism (one jar per identity on the network path through `chrome.debugger`, the prelude installed by the debugger). The **swap** mode has no debugger: the profile's own cookie store is saved into the identity's jar with `chrome.cookies` and the next identity's jar is written back, and the prelude, a plain content script, learns the active identity from a cookie the extension sets. In both modes A → B → A → C → A ran three times in one tab (same `tabId`), every switch loaded a new document, nobody signed in twice, each identity found its cookies and every page storage API intact, and a reset gave an identity an empty jar and namespace while the others kept theirs. The tab-group POC's known leaks (shared-worker requests, the extension-reload window, service workers disabled) do not affect saving or restoring data; they are listed under Limitations as out of scope. The product choice behind the API is recorded in the Session panel sketch: the developer picks another identity, RECnRun decides Start versus Resume, and Reset is explicit.

## 1. Environment, setup, reproduction, cleanup

| Item    | Value                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| OS      | macOS 27.0.1, arm64 (host runs); Docker image of `Dockerfile.tests` with Xvfb (gate runs)                                       |
| Browser | Playwright Chromium 156.0.8078.4, temporary profile, no extra flags; the lab extension loaded unpacked, variant `N2B1`          |
| Node    | v22.22.2                                                                                                                        |
| Fixture | `http://app.localhost:4318` (app, purchase-order workflow) and `http://idp.localhost:4319` (identity provider), fictional users |
| Users   | A = Admin (creates), B = Requester (submits), C = Approver (approves)                                                           |

```sh
vp install
vp run test:containers-lab          # unit checks, now including sessions.checks.mjs (node --test)
vp run test:single-tab              # the three specs in Docker (Xvfb), once per mode
vp run test:single-tab:local        # the same on the host, for debugging
SINGLE_TAB_MODE=swap node --test --test-concurrency=1 scripts/containers-lab/single-tab/*.spec.mjs   # one mode
```

Each spec starts the fixture, launches Chromium with the lab extension in a `mkdtemp` profile, opens one managed tab, writes `.artifacts/containers-lab/single-tab-<name>.json`, and deletes the profile on close. The specs run one at a time (`--test-concurrency=1`): they share the fixture ports. No step is manual.

## 2. Architecture

The previous POC gave each identity its own tab (group). This one keeps the identity a container (a cookie jar plus a storage namespace, as before) but binds it to a tab for a while, not forever. The session manager runs a tab in one of two modes, fixed by the tab's first activation (`activate(tabId, identity, { mode })`):

| Mode       | Cookies                                                                                                                                                                                              | Storage namespace                                                                                                                    | Needs                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `debugger` | One jar per identity, written into every request by `chrome.debugger` Fetch interception (N2); `Set-Cookie` attributed to the document that made the request.                                        | The prelude, registered by the debugger with the container before any document (B1).                                                 | `debugger` permission, the infobar    |
| `swap`     | The profile's own store holds the active identity's cookies; `swap.js` saves them (HttpOnly included) into the jar once the tab's requests drained (`network-idle.js`) and writes the next jar back. | The same prelude as a manifest content script (`control-start.js`), reading the identity from the `__rnr` cookie the extension sets. | `cookies` and `scripting` permissions |

Modules in the extension:

| Module                           | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/sessions.js`          | The session manager. `activate(tabId, identity, { reset, url, idleTimeoutMs })` is the one operation; it decides Start (first use), Resume (an existing container), or Reset (`reset: true`: a new generation `b.2`, the old jar cleared). Switches run through one queue, so two calls never interleave. A tab is `idle`, `switching`, `active`, or `failed`.                                                                                                                                                                                                  |
| `extension/documents.js`         | Which identity each document belongs to. CDP's `loaderId` (from `Network.requestWillBeSent` and `Page.frameNavigated`) and webNavigation's `documentId` are mapped to the container that was active when the document was created. A paused request is attributed to its document, never to the tab's current identity; while the tab is switching no identity is active, and a request whose document is unknown is blocked (`Fetch.failRequest`).                                                                                                             |
| `extension/swap.js`              | The swap mode's cookie moves: `save(jar)` reads the app's domains with `chrome.cookies.getAll` and stores them in the jar (the jar's cookie shape); `empty()` removes the store's cookies; `restore(jar)` sets them back and sets `__rnr=<container>` on each domain. Before the first switch the profile's own cookies go to the jar `profile`. The tab's `store` names the jar the store holds in full, or null once the jar is saved or while a restore is incomplete, so a switch that failed while emptying or restoring never saves leftovers over a jar. |
| `extension/network-idle.js`      | The requests in flight per tab, counted with `webRequest` from `onBeforeRequest` to `onCompleted` or `onErrorOccurred`. `waitForIdle(tabId, timeoutMs)` resolves once the tab has none, or at the timeout with the ones left. The swap mode calls it after `about:blank` committed (no document of the old identity can start a request any more) and before it saves the store, so a keepalive request's late `Set-Cookie` is saved into the right jar; a plain request is aborted with its document.                                                          |
| `extension/sessions-block.js`    | One session DNR rule per failed tab (id `20000 + tabId`, priority 100) that blocks every request until the next switch succeeds, so a failure never continues with the wrong identity.                                                                                                                                                                                                                                                                                                                                                                          |
| `extension/registry.js` (change) | `pin(tabId, container)` overrides the tab-group classification for a managed tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `extension/n2.js` (change)       | `rebind(tabId, container)` moves the attached debugger session to the next container; `decide` from `documents.js` runs before every paused request.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `extension/b1.js` (change)       | `switchPrelude(tabId, container)` reinstalls the namespacing prelude for the next container before the next document.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

A switch, in order:

1. **Suspend.** The active identity's `lastUrl` is saved (the tab's URL). The tab's phase becomes `switching`: no identity is active, so any navigation request is blocked (`navigation-while-switching`) and any subresource request is attributed to the document that made it, or blocked.
2. **Neutralize.** `chrome.tabs.update(tabId, { url: "about:blank" })`, and the manager waits for `webNavigation.onCommitted` of that document. The previous document is gone, with its JavaScript heap, its `sessionStorage` view, and its Web Locks.
3. **Bind.** Debugger mode: the debugger session is rebound to the next container (or re-attached if it was lost), the tab is pinned to the container in the registry, the DNR rules are refreshed, and the prelude is reinstalled with `Page.addScriptToEvaluateOnNewDocument`. Swap mode: step 1 already moved the store's cookies into the suspended identity's jar; now the next identity's jar is written into the store, with the `__rnr` cookie that names the container, and the tab remembers whose cookies the store holds (so a failed switch is stashed into the right jar). Either way the cookies and the prelude are in place before any application request.
4. **Resume.** The tab's phase becomes `active`, the block rule (if any) is removed, and the tab navigates to `url` or the identity's `lastUrl`. The manager waits for that document's commit and returns a receipt: `{ tabId, from, to, kind, container, neutral: { documentId, url }, document: { documentId, url }, ms }`.

If step 3 or 4 throws, the tab's phase becomes `failed`, the block rule is installed, and `activate` rejects; the next successful `activate` clears it. A debugger detach on an active tab (the user closing the infobar, for example) has the same effect.

In both modes storage is preserved because nothing is copied: the jar of container `a` keeps A's cookies while B is active, and the prelude maps B's `localStorage`, IndexedDB, CacheStorage, OPFS, `BroadcastChannel`, and Web Locks to B's namespace. Resume rebinds the same container; Reset binds a new one. `sessionStorage` is per tab in Chrome, and the prelude namespaces it per container, so A's `sessionStorage` survives the neutral navigation and B's turn (§3).

### Files

| File                                                                               | Lines | Purpose                                                                                                              |
| ---------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `scripts/containers-lab/extension/sessions.js`                                     | 214   | Session manager, both modes (new)                                                                                    |
| `scripts/containers-lab/extension/network-idle.js`                                 | 53    | Pending requests per tab, from `webRequest` (new)                                                                    |
| `scripts/containers-lab/extension/swap.js`                                         | 92    | Cookie save, empty, and restore with `chrome.cookies` (new)                                                          |
| `scripts/containers-lab/extension/control-start.js`                                | 13    | The content-script prelude takes the identity from the `__rnr` cookie (changed)                                      |
| `scripts/containers-lab/extension/documents.js`                                    | 156   | Document ↔ identity attribution (new)                                                                                |
| `scripts/containers-lab/extension/sessions-block.js`                               | 45    | Block rule for failed tabs (new)                                                                                     |
| `scripts/containers-lab/extension/{registry,n2,b1,rules,bootstraps,background}.js` |       | Pinning, rebinding, prelude switch, Set-Cookie ownership, lab handle (changed)                                       |
| `scripts/containers-lab/single-tab/harness.mjs`                                    | 113   | One managed tab, sign-in, order page, fixture log queries                                                            |
| `scripts/containers-lab/single-tab/manual.mjs`                                     | 101   | Headed Chromium and a prompt to switch identities by hand (new)                                                      |
| `scripts/containers-lab/single-tab/flow.spec.mjs`                                  | 101   | A → B → A → C → A, three rounds                                                                                      |
| `scripts/containers-lab/single-tab/storage.spec.mjs`                               | 92    | Page APIs across suspend, resume, and reset                                                                          |
| `scripts/containers-lab/single-tab/transitions.spec.mjs`                           | 274   | Pending requests (one, a burst, one past the idle timeout), queued switches, injected failures, IdP redirects, cache |
| `scripts/containers-lab/sessions.checks.mjs`                                       | 50    | Unit checks for `containerIdOf` and `decide`                                                                         |
| `scripts/containers-lab/network-idle.checks.mjs`                                   | 54    | Unit checks for `waitForIdle` (new)                                                                                  |
| `scripts/containers-lab/fixture/order.html`, `fixture-server.mjs`                  |       | Order page and a `/slow` route (changed)                                                                             |

### Manual run

`node scripts/containers-lab/single-tab/manual.mjs` (`SINGLE_TAB_MODE=debugger` for the other mode) starts the fixture, opens a headed Chromium with the lab extension and one tab, and reads commands from the terminal: `A`, `B`, `C` switch (Start or Resume decided by the manager, `/home` for a first Start), `A /order?id=1` switches and opens that path, `reset B` starts B afresh, `login Admin` signs the active identity in through the fixture's form, and `sessions`, `jar a`, and `events` show the manager's state. The fixture's pages (`/home`, `/order?id=1`, `/apis`) show who the backend sees and what each storage API holds.

Against a real site, `--url` and `--domains` make the run cover it: the script copies the extension into a temporary directory whose manifest adds `*://*.<domain>/*` to the host permissions and to the prelude's matches, the swap moves every cookie of the disposable profile (partitioned ones included) rather than the lab's hosts', and the identity cookie is set on each listed domain (`--cookies-only` leaves the prelude out, so only cookies are per identity). For two Gmail accounts:

```sh
node scripts/containers-lab/single-tab/manual.mjs --url https://mail.google.com \
  --domains google.com,youtube.com,googleusercontent.com,googleapis.com,gstatic.com
> A              # sign account 1 in by hand in the window
> B              # an empty store: Google asks for an account; sign account 2 in
> A              # account 1's inbox, no sign-in
```

Checked by the same drive against `https://httpbin.org/cookies`: A set `sid=admin`, B set `sid=requester`, and A resumed seeing `sid=admin` while jar `b` held B's cookie; with the swap restricted to the lab's hosts (the red control) A resumed seeing B's cookie. Expect on a real site: a switch is as slow as the slowest keepalive request left by the page, a service worker registered by the site stays shared across identities (out of scope), and the site receives the `__rnr` cookie.

## 3. Tests and results

All runs, both modes: `vp run test:single-tab` in Docker, debugger 12/12 with the two swap-only cases skipped and swap 13/13 with the debugger-only case skipped; `vp run test:single-tab:local` on the host, the same; `vp run test:containers-lab`, 29/29. The tables below show the debugger mode's numbers; the swap mode's differences follow each section.

### The workflow, three rounds (`flow.spec.mjs`)

Each round creates a new order. A turn activates the identity on the order page, signs in only if the page says "signed out", acts, and re-reads the order from the backend. The profile's own jar holds a cookie `profile=real-chrome-jar` for the app from the start.

| Round | Turn | Kind   | Container | Switch | Neutral doc | App doc  | Order state | Signed in | Session on the wire |
| ----- | ---- | ------ | --------- | ------ | ----------- | -------- | ----------- | --------- | ------------------- |
| 1     | A    | start  | a         | 43 ms  | 5326770A    | 98F61B61 | created     | yes       | Admin               |
| 1     | B    | start  | b         | 20 ms  | 8EFD01DE    | B97E84EB | submitted   | yes       | Requester           |
| 1     | A    | resume | a         | 24 ms  | 0AC83155    | 5DBE9243 | submitted   | no        | Admin               |
| 1     | C    | start  | c         | 19 ms  | D89B450F    | 0142ECE1 | approved    | yes       | Approver            |
| 1     | A    | resume | a         | 22 ms  | 14B71DB7    | C4F7F81D | approved    | no        | Admin               |
| 2     | A    | resume | a         | 19 ms  | 20C13D52    | E8B63719 | created     | no        | Admin               |
| 2     | B    | resume | b         | 18 ms  | CAF15CE4    | 64D57777 | submitted   | no        | Requester           |
| 2     | A    | resume | a         | 20 ms  | FF4771CD    | 8FC1EAF5 | submitted   | no        | Admin               |
| 2     | C    | resume | c         | 18 ms  | F934DBDB    | 95F182EE | approved    | no        | Approver            |
| 2     | A    | resume | a         | 25 ms  | 838DDEA9    | 83429942 | approved    | no        | Admin               |
| 3     | A    | resume | a         | 20 ms  | B950B020    | ADD1DF6E | created     | no        | Admin               |
| 3     | B    | resume | b         | 22 ms  | 8326A8C7    | 598B5DD2 | submitted   | no        | Requester           |
| 3     | A    | resume | a         | 19 ms  | 38C6DE56    | E4AC72E6 | submitted   | no        | Admin               |
| 3     | C    | resume | c         | 19 ms  | E35995FD    | BD8C22E3 | approved    | no        | Approver            |
| 3     | A    | resume | a         | 24 ms  | 251F0306    | 12BA8E9C | approved    | no        | Admin               |

Assertions that passed, per round and over all 15 turns:

- Every receipt has the same `tabId`, and Chrome has exactly one tab on the app's origin.
- The 30 `documentId`s (15 neutral, 15 app) are all distinct; a nonce planted on `window` before each switch is gone after it; `performance.timeOrigin` changes on every switch. `commits(tabId)` lists at least two main-frame commits per switch.
- The fixture created exactly one session per user (3 sign-ins in 15 turns, all in round 1; A resumed 8 times).
- The backend's state is what each identity sees: A sees `submitted` after B, `approved` after C, with the history.
- Every request the fixture logged during a turn carried that identity's `sid` or none (before its sign-in); none carried `profile=real-chrome-jar`, and the profile's jar still holds only that cookie afterwards.
- No `switch-failed` or `session-lost` event.

Swap mode, same assertions: 15 turns, switches 18–46 ms, three sign-ins, 30 distinct documents. The profile's cookie for the app was moved into the jar `profile` at the first switch and never reached a request; at the end the store holds A's `sid` and the `__rnr` cookie only.

### Storage across suspend, resume, and reset (`storage.spec.mjs`)

On `/apis`, each identity writes its marker to `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB, CacheStorage, and OPFS, and holds a Web Lock.

- A, B, and C each read back their own marker in all six APIs after a resume, and `/me` answers with their user. The `sid` cookie, HttpOnly, never appears in `document.cookie`, while the fixture sees it on every request; `cookieStore` stays disabled, as in the previous POC.
- After A's resume, the lock A's first document held is released (`heldLocks: []`): the old document is dead.
- Reset of B (`reset: true`): container `b.2`, every API reads `null`, no `localStorage` keys, no caches, `/me` answers signed out, and the jar `b` is empty. A and C then resume with their markers and their users intact; the identities are `a`, `b.2`, `c`. Admin still signed in once.
- `sessionStorage` written by A after a resume is invisible to C (`null`) and present for A at the next resume (`A2`): it survives the neutral navigation.
- The profile's jar is empty at the end: no session or marker reached it.

Swap mode, same results for every API, reset, and `sessionStorage`. Differences: `cookieStore` is Chrome's own (not disabled), and the store holds the active identity's cookies at any time (`sid`, `marker`, `__rnr` while C is active).

### Transitions (`transitions.spec.mjs`)

| Case                              | Result                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending request across the switch | A's document starts `fetch("/slow?ms=1500", { keepalive: true })`, then B is activated (29 ms). The fixture saw the request with Admin's `sid`; its late `Set-Cookie: late=Admin` landed in jar `a`, not in jar `b`; B's `/me` answers Requester. The delayed response is attributed to the document that made the request, by `documentId`.    |
| Burst of pending requests         | A's document starts three keepalive `/slow` requests (300, 900, 1500 ms) and one plain `fetch` (1200 ms), then B is activated (34 ms). All four reached the fixture with Admin's `sid`; `late=Admin` is in jar `a`, jar `b` has none. The plain request died with A's document; the keepalive ones were attributed to it.                       |
| Rapid switches                    | Three `activate` calls in one tick (A, B, A) ran serialized as B→A, A→B, B→A in 33, 40, and 24 ms, six distinct documents, the tab ends as Admin, no failure.                                                                                                                                                                                   |
| Reconfiguration failure           | `failNext("reconfigure")` makes the bind step throw after the debugger is rebound. `activate` rejects with the injected error; the tab's phase is `failed`; a session block rule exists; `page.goto(/home)` fails with `net::ERR_BLOCKED_BY_CLIENT`; the next `activate("B")` succeeds and `/me` answers Requester, and the block rule is gone. |
| Lost debugger session             | `failNext("detach")` detaches before the bind. Events, in order: `switch-started`, `n2-attached`, `n2-request /home` (with a `sid`), `switch-done`. Interception was re-established before the first application request; the page renders Admin.                                                                                               |
| Cross-origin sign-in              | C signs in through the identity provider (`/authorize` → `/callback` → `/home`, with the provider's own cookies). Jar `c` holds `idp_embed`, `idp_user`, `sid`; jar `a` holds no provider cookie; A resumes as Admin; the profile's jar stays empty.                                                                                            |
| Cacheable private response        | `/me-cached` answers Admin for A and Approver for C after the switch, with two server hits: the cache bypass of the previous POC holds across identities in one tab.                                                                                                                                                                            |

Swap mode: the switch waits for the tab's requests after `about:blank` committed and before it saves the store (`network-settled` event, default timeout 5 s). The pending request kept A's `sid` and its late `Set-Cookie: late=Admin` was saved into jar `a`, not into B's store: the switch took 1528 ms, of which 1499 ms were the wait. The burst waited 1497 ms for all four requests (the plain one was aborted at `about:blank`, the three keepalive ones completed), and `late=Admin` is in jar `a` only. A request that outlives the timeout (`/slow?ms=3000` with `idleTimeoutMs: 500`) lets the switch go on at 634 ms with the request reported under `pending`; its late cookie then lands in B's store (`__rnr, sid` before, `__rnr, late, sid` 3.5 s later) and in B's jar at B's next suspend: the documented cost of giving up. Queued switches ran B→A, A→B, B→A in 39, 45, and 25 ms. The reconfiguration failure (injected after the cookies are written) blocked the tab the same way and the retry recovered. A failure injected while the store is emptied (one cookie removed, the rest left: `__rnr`, `late`) blocks the tab the same way; the retry removes the leftovers without saving them, B resumes as Requester and A as Admin with `sid` still in jar `a`. The lost-debugger case is skipped. The identity provider's `idp_embed` cookie (`SameSite=None; Secure` over `http://idp.localhost`) is refused by Chrome's own store, so jar `c` holds `idp_user` and `sid`; the lab's jar had accepted it. `/me-cached` still gives two hits: the cache bypass applies to every tab while the lab runs.

### Unit checks (`sessions.checks.mjs`)

`containerIdOf("A", 1)` is `a`, generation 2 is `a.2`. `waitForIdle` (`network-idle.checks.mjs`, with a fake `chrome.webRequest`): an idle tab resolves at once; a wait ends when the tab's last request completes or fails and ignores other tabs' requests; a wait past its timeout reports what is pending; a request outside any tab (`tabId` -1) is not tracked. `decide`: an unmanaged tab keeps its container; a navigation while switching is blocked and an active identity gets its container; a child session (worker, frame) uses the container it was bound to or is blocked; a subresource whose document never reported is blocked after the 200 ms wait.

## 4. Red/green evidence and verification

Each spec was run against a deliberately broken extension (the change made with `sed`, the file restored from a copy afterwards, the restore verified with `diff`), then against the real code.

- **New document per switch.** Red: `transition` skips the neutral navigation (`neutral = { documentId: "none" }`): `flow.spec.mjs` fails at the distinct-`documentId` assertion (0 pass, 1 fail). Green: 1/1 on the host and in Docker.
- **Storage per identity.** Red: `bind` pins every identity to container `a`: `storage.spec.mjs` fails on the markers (1 pass, 2 fail; B reads A's markers). Green: 2/2.
- **Set-Cookie ownership.** Red: `containerForResponse` returns the tab's current container for every response: `transitions.spec.mjs` fails the pending-request case (`late=Admin` lands in jar `b`; 5 pass, 2 fail). Green: 6/6.
- **Swap: cookies restored.** Red: `restore` writes nothing back into the store: `flow.spec.mjs` in swap mode fails because every turn signs in again (sign-ins `Admin, Requester, Admin, Approver, Admin, …`). Green: 1/1.
- **Swap: the prelude's identity.** Red: `control-start.js` ignores the `__rnr` cookie: `storage.spec.mjs` in swap mode fails because A reads C's markers in every API. Green: 2/2.
- **Swap: recovery after a partial emptying.** Red: `failNext("empty")` removes one cookie and throws while `tab.store` still names the jar (the previous code): `transitions.spec.mjs` in swap mode fails because A resumes signed out (`/me` is null; the next switch had saved the leftovers over jar `a`), and the later cases fail with it (5 pass, 4 fail). Green: 9/9.
- **Swap: the network wait.** Red: the new pending, burst, and timeout cases run against the extension before `network-idle.js` (commit `6e6c3fe`): 3 fail (`late` is null in jar `a`, no `network-settled` event; 4 pass, 1 skipped). Green: 8/8 in swap mode, and 7/7 plus the skipped timeout case in debugger mode, five runs each. One debugger-mode run failed the burst case while its wait was 2000 ms; the wait is 2500 ms, as in the pending case, since then.
- **Earlier, during development.** A `/me` request of a document the harness destroyed before `Network.requestWillBeSent` arrived was blocked as `unknown-document`, then `Fetch.failRequest` answered "Invalid InterceptionId": the request was gone with its document. `block` now tolerates that and records `request-gone`.
- **Gates.** `vp check`, `vp run deps`, Knip, and jscpd pass. `vp run verify` exits 0 in Docker (23/23 tasks) with both modes in the tree. `vp run test:single-tab` is not part of `verify`: it takes a full Chromium with the lab extension per spec, like the other lab harnesses.

## 5. Answers

- **Can one tab serve several identities with their state intact?** Yes. A → B → A → C → A ran three times in one tab; every identity resumed with its HTTP cookies (HttpOnly included), `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, CacheStorage, and OPFS, and nobody signed in twice.
- **Is every switch a new document?** Yes, by construction (`about:blank` in between, its commit awaited) and by evidence (distinct `documentId`s, the planted nonce gone, a new `performance.timeOrigin`, and released Web Locks).
- **Are delayed requests attributed correctly?** Yes: by the document that made them, through CDP's `loaderId` and webNavigation's `documentId`, including a late `Set-Cookie`. When the document cannot be determined the request is blocked, never served with the current identity.
- **What happens when a switch fails?** The tab is blocked by a DNR rule and `activate` rejects; the next successful switch unblocks it. A lost debugger session is re-attached before any application request.
- **Does the mechanism need anything beyond the previous POC?** No new dependency, no new layer, no production change: three extension modules, one fixture page, one fixture route, and the specs.
- **Does it work without the debugger?** Yes: the swap mode. Cookies move through `chrome.cookies` at the switch (HttpOnly included, session cookies restored as session cookies), the prelude is a manifest content script that reads the identity from a cookie, and every spec but the lost-debugger case passes with the same assertions. Costs measured: a request pending across the switch is waited for after `about:blank` (bounded by `idleTimeoutMs`, 5 s by default), so its late `Set-Cookie` is saved into the right jar unless the switch gave up on it, in which case the cookie lands in the next identity's store and the switch reports the request; the wait is the switch's cost (1.5 s for a 1.5 s request, against 35 ms in debugger mode); the profile's own session on the site becomes one more jar (`profile`); Chrome's store applies its own cookie rules (a `Secure` cookie over `http://idp.localhost` is refused); workers get no namespace (content scripts do not run in them). None of these touches the data of a suspended identity.
- **Recommended integration.** Expose one action, "Switch identity", with an optional `reset` and a per-step `url`, as `activate(tabId, identity, { reset, url })` does; let RECnRun decide Start versus Resume. A recording captures the sequence of identities; the runner replays it with the same calls. For a product that only saves and restores data, ship the swap mode: no `debugger` permission, no infobar, `cookies` and `scripting` only, and the jar and the prelude as tested domain logic. Keep the debugger mode in the lab as the reference for request attribution if network isolation ever becomes a goal.

## Limitations

Out of scope (inherited from the tab-group POC, unchanged, not affecting saved or restored data): a shared worker's network requests carry the profile's own cookies; requests made while the extension reloads carry them too; service workers are disabled in containers; the HTTP cache is bypassed on the app's hosts; `cookieStore` is disabled; IP, fingerprint, HSTS, the HTTP authentication cache, TLS client certificates, permissions, WebAuthn, autofill, and storage quota are shared.

Specific to save and restore in one tab:

- **Back/forward cache.** Playwright disables bfcache, so whether Chrome could restore a suspended document from it (skipping the neutral navigation) was not tested. The prelude is per document, so a bfcache restore would need its own handling.
- **`beforeunload` prompts.** A page that asks before leaving could hold the neutral navigation; not tested. The 5 s commit timeout would fail the switch and block the tab.
- **Pending requests of the old document** finish with their own identity in the debugger mode. In the swap mode the switch waits for them (keepalive requests complete, plain ones are aborted with the document) and only then saves the store; a request that outlives `idleTimeoutMs` is reported and its late `Set-Cookie` lands in the next identity's store (measured). Either way the suspended identity's data is intact. The wait makes a swap switch as slow as the slowest keepalive request.
- **Swap mode and other tabs.** The profile's store is one per profile, so another tab on the same site shows the active identity too, and the `__rnr` cookie reaches the server with every request. The swap mode is a one-tab-at-a-time model by construction.
- **Swap mode and workers.** Content scripts do not run in workers, so a dedicated or shared worker uses the origin's unprefixed storage.
- **`sessionStorage`** is preserved per identity because the prelude namespaces it; without the prelude Chrome keeps one `sessionStorage` per tab across identities.
- **The debugger infobar** stays on the managed tab in the debugger mode; the swap mode has none.
- **Manual checks** (DevTools on the managed tab, branded Chrome, idle suspension) were not done; a real sign-in flow (Google's) was not run, only a cookie round trip through httpbin.org.
