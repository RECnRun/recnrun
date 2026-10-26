# RECnRun — POC results: Single-tab multi-user sessions

Branch `poc/single-tab-multi-user`, based on `poc/tab-group-containers` (`d150bf6`, [its report](poc-tab-group-containers-results.md)). The lab is the same unpacked MV3 extension under `scripts/containers-lab/`, extended with a session manager; nothing under `apps/` or `packages/` changed, and the production manifest guard still passes.

**Scope.** Save and restore each identity's data (HTTP cookies, HttpOnly included, `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, CacheStorage, OPFS) across switches in one tab, with a new document on every switch. Isolating the network, service workers, and other workers is out of scope: the lab's debugger interception and prelude are used here as the mechanism that keeps one jar and one storage namespace per identity, not as a security boundary.

**Verdict: PASS** for that scope. A → B → A → C → A ran three times in one tab (same `tabId`), every switch loaded a new document, nobody signed in twice, each identity found its cookies and every page storage API intact, and a reset gave an identity an empty jar and namespace while the others kept theirs. The tab-group POC's known leaks (shared-worker requests, the extension-reload window, service workers disabled) do not affect saving or restoring data; they are listed under Limitations as out of scope. §5 recommends a leaner mechanism for the product: swap cookies with `chrome.cookies` and keep the storage prelude, without `chrome.debugger`. The product choice behind the API is recorded in the Session panel sketch: the developer picks another identity, RECnRun decides Start versus Resume, and Reset is explicit.

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
vp run test:single-tab              # the three specs in Docker (Xvfb)
vp run test:single-tab:local        # the same on the host, for debugging
```

Each spec starts the fixture, launches Chromium with the lab extension in a `mkdtemp` profile, opens one managed tab, writes `.artifacts/containers-lab/single-tab-<name>.json`, and deletes the profile on close. The specs run one at a time (`--test-concurrency=1`): they share the fixture ports. No step is manual.

## 2. Architecture

The previous POC gave each identity its own tab (group). This one keeps the identity a container (a cookie jar plus a storage namespace, as before) but binds it to a tab for a while, not forever. Three new modules in the extension, all behind the existing `chrome.debugger` Fetch interception (N2) and the page prelude (B1):

| Module                           | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/sessions.js`          | The session manager. `activate(tabId, identity, { reset, url })` is the one operation; it decides Start (first use), Resume (an existing container), or Reset (`reset: true`: a new generation `b.2`, the old jar cleared). Switches run through one queue, so two calls never interleave. A tab is `idle`, `switching`, `active`, or `failed`.                                                                                                     |
| `extension/documents.js`         | Which identity each document belongs to. CDP's `loaderId` (from `Network.requestWillBeSent` and `Page.frameNavigated`) and webNavigation's `documentId` are mapped to the container that was active when the document was created. A paused request is attributed to its document, never to the tab's current identity; while the tab is switching no identity is active, and a request whose document is unknown is blocked (`Fetch.failRequest`). |
| `extension/sessions-block.js`    | One session DNR rule per failed tab (id `20000 + tabId`, priority 100) that blocks every request until the next switch succeeds, so a failure never continues with the wrong identity.                                                                                                                                                                                                                                                              |
| `extension/registry.js` (change) | `pin(tabId, container)` overrides the tab-group classification for a managed tab.                                                                                                                                                                                                                                                                                                                                                                   |
| `extension/n2.js` (change)       | `rebind(tabId, container)` moves the attached debugger session to the next container; `decide` from `documents.js` runs before every paused request.                                                                                                                                                                                                                                                                                                |
| `extension/b1.js` (change)       | `switchPrelude(tabId, container)` reinstalls the namespacing prelude for the next container before the next document.                                                                                                                                                                                                                                                                                                                               |

A switch, in order:

1. **Suspend.** The active identity's `lastUrl` is saved (the tab's URL). The tab's phase becomes `switching`: no identity is active, so any navigation request is blocked (`navigation-while-switching`) and any subresource request is attributed to the document that made it, or blocked.
2. **Neutralize.** `chrome.tabs.update(tabId, { url: "about:blank" })`, and the manager waits for `webNavigation.onCommitted` of that document. The previous document is gone, with its JavaScript heap, its `sessionStorage` view, and its Web Locks.
3. **Bind.** The debugger session is rebound to the next container (or re-attached if it was lost), the tab is pinned to the container in the registry, the DNR rules are refreshed, and the prelude is reinstalled with `Page.addScriptToEvaluateOnNewDocument`. Interception and the prelude are in place before any application request.
4. **Resume.** The tab's phase becomes `active`, the block rule (if any) is removed, and the tab navigates to `url` or the identity's `lastUrl`. The manager waits for that document's commit and returns a receipt: `{ tabId, from, to, kind, container, neutral: { documentId, url }, document: { documentId, url }, ms }`.

If step 3 or 4 throws, the tab's phase becomes `failed`, the block rule is installed, and `activate` rejects; the next successful `activate` clears it. A debugger detach on an active tab (the user closing the infobar, for example) has the same effect.

Storage is preserved because nothing is copied: the jar of container `a` keeps A's cookies while B is active, and the prelude maps B's `localStorage`, IndexedDB, CacheStorage, OPFS, `BroadcastChannel`, and Web Locks to B's namespace. Resume rebinds the same container; Reset binds a new one. `sessionStorage` is per tab in Chrome, and the prelude namespaces it per container, so A's `sessionStorage` survives the neutral navigation and B's turn (§3).

### Files

| File                                                                               | Lines | Purpose                                                                        |
| ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `scripts/containers-lab/extension/sessions.js`                                     | 157   | Session manager (new)                                                          |
| `scripts/containers-lab/extension/documents.js`                                    | 156   | Document ↔ identity attribution (new)                                          |
| `scripts/containers-lab/extension/sessions-block.js`                               | 45    | Block rule for failed tabs (new)                                               |
| `scripts/containers-lab/extension/{registry,n2,b1,rules,bootstraps,background}.js` |       | Pinning, rebinding, prelude switch, Set-Cookie ownership, lab handle (changed) |
| `scripts/containers-lab/single-tab/harness.mjs`                                    | 113   | One managed tab, sign-in, order page, fixture log queries                      |
| `scripts/containers-lab/single-tab/flow.spec.mjs`                                  | 101   | A → B → A → C → A, three rounds                                                |
| `scripts/containers-lab/single-tab/storage.spec.mjs`                               | 92    | Page APIs across suspend, resume, and reset                                    |
| `scripts/containers-lab/single-tab/transitions.spec.mjs`                           | 155   | Pending requests, queued switches, injected failures, IdP redirects, cache     |
| `scripts/containers-lab/sessions.checks.mjs`                                       | 50    | Unit checks for `containerIdOf` and `decide`                                   |
| `scripts/containers-lab/fixture/order.html`, `fixture-server.mjs`                  |       | Order page and a `/slow` route (changed)                                       |

## 3. Tests and results

All runs: `vp run test:single-tab` in Docker, 11/11; `vp run test:single-tab:local` on the host, 11/11; `vp run test:containers-lab`, 25/25.

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

### Storage across suspend, resume, and reset (`storage.spec.mjs`)

On `/apis`, each identity writes its marker to `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB, CacheStorage, and OPFS, and holds a Web Lock.

- A, B, and C each read back their own marker in all six APIs after a resume, and `/me` answers with their user. The `sid` cookie, HttpOnly, never appears in `document.cookie`, while the fixture sees it on every request; `cookieStore` stays disabled, as in the previous POC.
- After A's resume, the lock A's first document held is released (`heldLocks: []`): the old document is dead.
- Reset of B (`reset: true`): container `b.2`, every API reads `null`, no `localStorage` keys, no caches, `/me` answers signed out, and the jar `b` is empty. A and C then resume with their markers and their users intact; the identities are `a`, `b.2`, `c`. Admin still signed in once.
- `sessionStorage` written by A after a resume is invisible to C (`null`) and present for A at the next resume (`A2`): it survives the neutral navigation.
- The profile's jar is empty at the end: no session or marker reached it.

### Transitions (`transitions.spec.mjs`)

| Case                              | Result                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending request across the switch | A's document starts `fetch("/slow?ms=1500", { keepalive: true })`, then B is activated (29 ms). The fixture saw the request with Admin's `sid`; its late `Set-Cookie: late=Admin` landed in jar `a`, not in jar `b`; B's `/me` answers Requester. The delayed response is attributed to the document that made the request, by `documentId`.    |
| Rapid switches                    | Three `activate` calls in one tick (A, B, A) ran serialized as B→A, A→B, B→A in 33, 40, and 24 ms, six distinct documents, the tab ends as Admin, no failure.                                                                                                                                                                                   |
| Reconfiguration failure           | `failNext("reconfigure")` makes the bind step throw after the debugger is rebound. `activate` rejects with the injected error; the tab's phase is `failed`; a session block rule exists; `page.goto(/home)` fails with `net::ERR_BLOCKED_BY_CLIENT`; the next `activate("B")` succeeds and `/me` answers Requester, and the block rule is gone. |
| Lost debugger session             | `failNext("detach")` detaches before the bind. Events, in order: `switch-started`, `n2-attached`, `n2-request /home` (with a `sid`), `switch-done`. Interception was re-established before the first application request; the page renders Admin.                                                                                               |
| Cross-origin sign-in              | C signs in through the identity provider (`/authorize` → `/callback` → `/home`, with the provider's own cookies). Jar `c` holds `idp_embed`, `idp_user`, `sid`; jar `a` holds no provider cookie; A resumes as Admin; the profile's jar stays empty.                                                                                            |
| Cacheable private response        | `/me-cached` answers Admin for A and Approver for C after the switch, with two server hits: the cache bypass of the previous POC holds across identities in one tab.                                                                                                                                                                            |

### Unit checks (`sessions.checks.mjs`)

`containerIdOf("A", 1)` is `a`, generation 2 is `a.2`. `decide`: an unmanaged tab keeps its container; a navigation while switching is blocked and an active identity gets its container; a child session (worker, frame) uses the container it was bound to or is blocked; a subresource whose document never reported is blocked after the 200 ms wait.

## 4. Red/green evidence and verification

Each spec was run against a deliberately broken extension (the change made with `sed`, the file restored from a copy afterwards, the restore verified with `diff`), then against the real code.

- **New document per switch.** Red: `transition` skips the neutral navigation (`neutral = { documentId: "none" }`): `flow.spec.mjs` fails at the distinct-`documentId` assertion (0 pass, 1 fail). Green: 1/1 on the host and in Docker.
- **Storage per identity.** Red: `bind` pins every identity to container `a`: `storage.spec.mjs` fails on the markers (1 pass, 2 fail; B reads A's markers). Green: 2/2.
- **Set-Cookie ownership.** Red: `containerForResponse` returns the tab's current container for every response: `transitions.spec.mjs` fails the pending-request case (`late=Admin` lands in jar `b`; 5 pass, 2 fail). Green: 6/6.
- **Earlier, during development.** A `/me` request of a document the harness destroyed before `Network.requestWillBeSent` arrived was blocked as `unknown-document`, then `Fetch.failRequest` answered "Invalid InterceptionId": the request was gone with its document. `block` now tolerates that and records `request-gone`.
- **Gates.** `vp check`, `vp run deps`, Knip, and jscpd pass. `vp run verify` exits 0 in Docker (23/23 tasks). `vp run test:single-tab` is not part of `verify`: it takes a full Chromium with the lab extension per spec, like the other lab harnesses.

## 5. Answers

- **Can one tab serve several identities with their state intact?** Yes. A → B → A → C → A ran three times in one tab; every identity resumed with its HTTP cookies (HttpOnly included), `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, CacheStorage, and OPFS, and nobody signed in twice.
- **Is every switch a new document?** Yes, by construction (`about:blank` in between, its commit awaited) and by evidence (distinct `documentId`s, the planted nonce gone, a new `performance.timeOrigin`, and released Web Locks).
- **Are delayed requests attributed correctly?** Yes: by the document that made them, through CDP's `loaderId` and webNavigation's `documentId`, including a late `Set-Cookie`. When the document cannot be determined the request is blocked, never served with the current identity.
- **What happens when a switch fails?** The tab is blocked by a DNR rule and `activate` rejects; the next successful switch unblocks it. A lost debugger session is re-attached before any application request.
- **Does the mechanism need anything beyond the previous POC?** No new dependency, no new layer, no production change: three extension modules, one fixture page, one fixture route, and the specs.
- **A leaner mechanism for save/restore only.** The debugger exists in this lab to give each identity its own jar on the network path. If only data matters, the same switch can run without it: at suspend, `chrome.cookies.getAll` on the app's domains (HttpOnly included) is saved as the identity's jar and removed from the profile's store; at resume, the next identity's jar is `chrome.cookies.set` back, before the navigation. Storage keeps the prelude (a namespace per identity, nothing copied), installed with `chrome.scripting.registerContentScripts` at `document_start` in the main world; the prelude learns the active identity synchronously from a cookie the extension sets on the app's domain, instead of from the debugger. Costs: requests in flight during the switch see the new cookies, the profile's own session on that site becomes one more identity to save and restore, and the prelude's coverage stays as the tab-group POC measured it (no service workers in a namespace; shared workers keep their own). None of these touches the data of a suspended identity. Not built; a next step if the product wants to drop the debugger infobar.
- **Recommended integration.** Expose one action, "Switch identity", with an optional `reset` and a per-step `url`, as `activate(tabId, identity, { reset, url })` does; let RECnRun decide Start versus Resume. A recording captures the sequence of identities; the runner replays it with the same calls. Keep the document attribution (`documents.js`) and the fail-closed rules as tested domain logic. Treat the known leaks below as product rules, as the previous POC recommended.

## Limitations

Out of scope (inherited from the tab-group POC, unchanged, not affecting saved or restored data): a shared worker's network requests carry the profile's own cookies; requests made while the extension reloads carry them too; service workers are disabled in containers; the HTTP cache is bypassed on the app's hosts; `cookieStore` is disabled; IP, fingerprint, HSTS, the HTTP authentication cache, TLS client certificates, permissions, WebAuthn, autofill, and storage quota are shared.

Specific to save and restore in one tab:

- **Back/forward cache.** Playwright disables bfcache, so whether Chrome could restore a suspended document from it (skipping the neutral navigation) was not tested. The prelude is per document, so a bfcache restore would need its own handling.
- **`beforeunload` prompts.** A page that asks before leaving could hold the neutral navigation; not tested. The 5 s commit timeout would fail the switch and block the tab.
- **Pending requests of the old document** finish with their own identity here; with the leaner mechanism above they would see the new cookies. Either way the suspended identity's data is intact.
- **`sessionStorage`** is preserved per identity because the prelude namespaces it; without the prelude Chrome keeps one `sessionStorage` per tab across identities.
- **The debugger infobar** stays on the managed tab, as in the previous POC; the leaner mechanism removes it.
- **Manual checks** (DevTools on the managed tab, branded Chrome, idle suspension) were not done.
