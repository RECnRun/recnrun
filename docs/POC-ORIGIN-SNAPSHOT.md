# POC report: origin snapshots in sequential Incognito sessions

Status: **Stage 2 done; stopped at Gate G2 for the user's go-ahead.** Gate G1 passed (go-ahead 2026-10-28). Plan: [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md). Assignment: [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md). Checklist: [poc-incognito-sessions-checklist.md](poc-incognito-sessions-checklist.md).

## 1. Verdicts

| Area                    | Verdict   | Evidence |
| ----------------------- | --------- | -------- |
| Native reset            | **GO**    | §5       |
| Data fidelity           | _pending_ |          |
| Startup barrier         | **GO**    | §6       |
| Capture consistency     | _pending_ |          |
| Local PWA compatibility | _pending_ |          |
| Zephyr                  | _pending_ |          |

## 2. Commits and environment

| Item                | Value                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| RECnRun base        | `44c154da29860c7a8df829e902b177df5ce2ba2a` (`origin/master`, re-resolved 2026-10-28 before implementation; unchanged from planning) |
| Branch              | `poc/incognito-sessions`, worktree `/Users/dannyelcf/src/recnrun-incognito-sessions-poc`                                            |
| SplitSession source | `475afe88cd1ec7208b2a5510759036955032e0d4` (read for test ideas only; no code copied)                                               |
| Host                | macOS 27.0.1 (26A434), Google Chrome 156.0.8078.49                                                                                  |
| Docker (every test) | Google Chrome for Testing 156.0.8078.4 on Linux 6.10.14-linuxkit, image `mcr.microsoft.com/playwright:v1.64.1-noble`, Xvfb, headed  |
| Tooling             | Playwright 1.64.1, WXT 0.21.4, Vite+ 1.4.0, Node 24.21.0 in Docker                                                                  |

### Baseline gate

`vp run verify` on the untouched base:

- First run: one end-to-end failure, `incognito.spec.ts` › "records an incognito tab, and the PiP window follows the current tab": the PiP's Current tab region showed "No tab in focus." instead of the focused incognito tab (`.artifacts/docker/2026-10-28T12-00-08.121Z-dbb72662-8def-498a-8859-16ba4478d5bd`). Everything else passed (151 unit and component tests, 41 of 42 end-to-end).
- `vp run test:e2e -- tests/e2e/incognito.spec.ts --repeat-each=5`: 25 passed (`.artifacts/docker/2026-10-28T12-01-24.996Z-95932d2d-eb71-4537-b8c7-d7d72ee00eb0`). The failure is a pre-existing window-focus flake on Xvfb, not caused by this POC; it is watched in later runs.
- Second run: exit 0, every gate passed, 42 of 42 end-to-end (`.artifacts/docker/2026-10-28T12-02-21.796Z-1433f9f5-2cce-4bf5-9a53-3c1e49edf6f6`).

## 3. Permissions per build

Per decision OD-1, only test and development builds gain the POC's permissions; `apps/extension/scripts/manifest.checks.mjs` checks both lists.

| Build             | `permissions`                                                                       | `host_permissions`                                                                                             | Other                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production        | `storage`, `tabs` (unchanged)                                                       | none                                                                                                           | `incognito: "spanning"`; no `message_serialization`; no origin agent script; no `recnrunPoc` test handles                                                         |
| Test (Docker e2e) | `storage`, `tabs`, `declarativeNetRequest`, `scripting`, `cookies`, `webNavigation` | `http://*.localhost/*`                                                                                         | `message_serialization: "structured_clone"`; `content-scripts/origin-agent.js` (runtime-registered, not in `content_scripts`); `recnrunPoc` on the service worker |
| Development       | as test                                                                             | as test, plus hosts from `RECNRUN_POC_HOSTS` (e.g. `https://zephyr-tq.one.be/*`, `https://login-acc.one.be/*`) | as test, without `recnrunPoc`                                                                                                                                     |

## 4. Stage 0: platform facts (P0.2)

Throwaway probe in a scratch worktree (nothing committed): the test build gained `declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, host access `http://*.localhost/*`, `"message_serialization": "structured_clone"`, and a WXT content script with `registration: "runtime"`. One Playwright spec (`incognitoAccess: true`) ran a local server on `app.localhost:5191`; the service worker created an Incognito window on `about:blank`, then did everything below. Command: `vp run test:e2e -- tests/e2e/zz-probe.spec.ts` (scratch copy, Docker), one run.

| Question                                                                                                 | Observed                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WXT keeps `message_serialization` in the built manifest                                                  | Yes: `runtime.getManifest().message_serialization === "structured_clone"`                                                                                                            |
| A port from an Incognito content script to the spanning worker carries structured values                 | Yes: `Date`, `Blob` (type and content), `ArrayBuffer`, `Uint16Array`, `Map`, and a 12 MiB string in one message arrived intact                                                       |
| The port's sender identifies tab, document, origin                                                       | Yes: `sender.tab.id`, `sender.documentId`, `sender.origin` (`http://app.localhost:5191`), `sender.tab.incognito === true`                                                            |
| `registration: "runtime"` entrypoint                                                                     | Emitted as `content-scripts/probe.js`, absent from the manifest's `content_scripts`; `scripting.registerContentScripts` ran it at `document_start` in the Incognito tab              |
| Cookie store of the Incognito tab                                                                        | `getAllCookieStores()` listed store `"1"` with the new tab's id; `cookies.set` with that `storeId` reached the page (`document.cookie === "probe=v"`) and not the normal store `"0"` |
| DNR session rule with `tabIds` appending `Content-Security-Policy: script-src 'none'; worker-src 'none'` | Applied in Incognito, through a 302 redirect: neither the inline script nor the module script ran, while the isolated-world script wrote `localStorage` on the origin                |
| DNR block of every non-`main_frame` request for the tab                                                  | The server saw only `/redirect?csp=1` and `/page`: no module, no image request                                                                                                       |
| Removing rules and scripts                                                                               | `getSessionRules()` and `getRegisteredContentScripts()` empty afterwards                                                                                                             |
| Cookie store after the last Incognito window closes                                                      | Gone 6 ms after `windows.remove` in this single run. Corrected by S1.7's 50 timed cycles: the store disappears after `onRemoved`, not before it (§5)                                 |

Not shown by this probe: whether the appended CSP keeps a site's own CSP in force (the `?csp=1` header was on the redirect response, not the final document), workers and subframes, a Service Worker serving the document (none exists in a fresh context), and repeated runs. Stage 2 covers them.

## 5. Stage 1: native reset

Verdict: **GO.** With no other Incognito window open, closing RECnRun's Incognito window and opening a new one right away gives a window with no site data, 50 times in a row, while the normal profile and the extension's own data stay intact. Stage 1 `vp run verify`: exit 0, 220 unit and component tests, 53 of 53 end-to-end, coverage 99.32% statements and 97.6% branches (`.artifacts/docker/2026-10-28T13-40-19.702Z-9d6e4aa9-d8a8-4096-97a4-2032ccf009d8`).

### What was built (S1.1–S1.5b)

- One managed Incognito window per browser (`local:managed-window`: generation, window id, tab id, active or closed). Every other Incognito window, Document PiP included, counts as foreign; only DevTools windows are left out.
- Commands from the dashboard only, one at a time (a second one is refused, not queued): Start, Close these windows and start (only the windows the user was shown; a changed set is refused), Close and start empty (replaces the managed window). Each refuses without "Allow in Incognito", since Chrome then hides Incognito windows and the inventory could prove nothing. Nothing is closed by a command that will then refuse.
- The dashboard's Incognito workspace panel lists foreign windows, never closes them silently, and offers a single action per state. Normal tabs offer "Use this tab's address" (the address only; no data is copied).
- Record is offered only on the managed tab (OD-2); while a recording exists, the commands that close windows are refused.

### Reset experiment (S1.6, `tests/e2e/poc-native-reset.spec.ts`)

The fixture's `/sentinel` writes a tagged value in each storage kind; `/inspect` reads them back, and the server reports the `Cookie` header it received, so the HttpOnly cookie is checked server-side.

| Observation                                                                                 | Result                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New managed window after "Close and start empty"                                            | Empty in every kind: JS cookie, HttpOnly cookie (server saw no `Cookie`), localStorage, IndexedDB database and record, Cache Storage entry, Service Worker registration and controller. Generation +1       |
| sessionStorage                                                                              | Empty, but it is per tab, so this proves nothing about the reset                                                                                                                                            |
| Normal tab on the same origin                                                               | Still reads `normal` in every kind                                                                                                                                                                          |
| Extension data                                                                              | Both seeded recordings still listed by the dashboard                                                                                                                                                        |
| Control: another Incognito window open                                                      | Panel lists it and offers no button                                                                                                                                                                         |
| Control: close only the managed window while the other stays, then open a new Incognito tab | Every kind but sessionStorage still holds `incog-1`, and the page is controlled by the old `sw.js`. Chrome keeps the Incognito session while any Incognito window lives, which is why foreign windows block |
| Scratch negative condition (new window opened before the old one closed)                    | The emptiness assertion fails with every kind holding `incog-1`, so the assertion catches leaks                                                                                                             |

### Stress and teardown signal (S1.7)

`POC_REPEATS=50`: one test runs 50 cycles of sentinel `incog-k` → reset issued as soon as the writes finished (no pause) → `/inspect`. **50 of 50 empty** (`.artifacts/docker/2026-10-28T13-36-22.690Z-cd60cc21-5853-4c9b-a4b8-0d80a9fa6808`, per-cycle data in the test's `teardown.json`). No product wait was added, because nothing leaked.

The command waits for `windows.onRemoved` of every closed window and an inventory that no longer lists them, then creates the new window. Timings from the service worker clock, ms, min / median / p95 / max:

| Step                                               | min  | median | p95  | max  |
| -------------------------------------------------- | ---- | ------ | ---- | ---- |
| `windows.remove` call → `onRemoved`                | 4.3  | 4.7    | 5.7  | 6.1  |
| call → first `getAll` with no Incognito window     | 12.7 | 13.9   | 16.1 | 16.6 |
| `onRemoved` → next `windows.create` call           | 10.4 | 11.6   | 12.7 | 14.0 |
| `create` call → `onCreated`                        | 13.9 | 14.6   | 15.6 | 17.0 |
| call → Incognito cookie store gone (scratch build) | 14.5 | 15.8   | 20.3 | 20.5 |
| store gone → `create` call (scratch build)         | 0.4  | 0.6    | 0.8  | 1.4  |

Order in all 50 cycles: remove call < `onRemoved` < no Incognito window listed < cookie store gone < create call < created. The cookie-store rows come from a scratch build with the `cookies` permission (50 of 50 empty, scratch run `2026-10-28T13-34-54.652Z-a5aba681-6986-4f7f-a33f-0fda09d2458e`), since the committed Stage 1 build lacks it.

**Risk carried into Stage 2.** The product does not wait for the cookie store to go; the margin between the store going and the next create was 0.4–1.4 ms, which is what these runs happened to see, not a guarantee. The store's disappearance is the closest observable sign that Chrome destroyed the Incognito profile. Once S2.2 adds `cookies` to test and development builds, the bootstrap sequence (S2.5) should also wait until `getAllCookieStores()` lists no Incognito store before creating the window, with its own red/green.

### Findings outside the POC's goal

- **PiP current tab across windows (fixed in S1.5b).** When focus moves between a normal and an Incognito window, `windows.getAll` can briefly report both as focused (2 of 3 probe runs); the PiP took the first and kept showing the old tab. It now prefers `windows.getLastFocused`. The restored end-to-end step passed 50 of 50 (`incognito.spec.ts --repeat-each=10`). This does not explain the baseline flake (§2), whose symptom was "No tab in focus." (no window focused); it did not recur in this stage's runs.
- **Synchronous throws in the message listener.** A route in `apps/extension/src/messaging/listener.ts` whose `run` throws synchronously gets no reply. The workspace commands avoid it by being `async`; the listener itself is unchanged (pre-existing, out of scope).
- Foreign windows on `about:blank` show as "about:blank" in the panel's list.

### Not shown by Stage 1

- Host Chrome on macOS (every run was Chrome for Testing 156 on Linux, Xvfb).
- Other keep-alives of the Incognito profile than an open window: a detached DevTools window inspecting an Incognito target, downloads in progress, or another extension's Incognito pages.
- Data held outside the site's storage (HTTP cache, DNS, TLS session, autofill): only the storage kinds above were checked.

## 6. Stage 2: startup barrier

Verdict: **GO.** In 100 of 100 recorded starts (50 with the restore returning at once, 50 with it held 2,000 ms), the application's first inline script read the restored cookie, localStorage, sessionStorage, and IndexedDB record, and nothing of the application ran or loaded before the data was in place. Without the barrier, the same 2,000 ms start lets the application run first and read empty values. Stage 2 `vp run verify`: exit 0, 302 unit and component tests, 61 of 61 end-to-end, coverage 99.27% statements and 96.78% branches (`.artifacts/docker/2026-10-28T15-55-19.650Z-116c118b-e472-4701-99a5-fa7c76dbe93c`).

### Mechanism

1. Wait until `cookies.getAllCookieStores()` lists no Incognito store (Gate G1's carried risk).
2. Create RECnRun's Incognito window on `about:blank`, then find the cookie store whose `tabIds` hold the managed tab. The id is never `"0"` or a constant.
3. Set the identity's cookies, HttpOnly ones included, with that `storeId`.
4. Install the barrier: four DNR session rules scoped to the managed tab.
   - Block every request type but `main_frame`.
   - Block `main_frame`, and allow it again only on the target origin. An off-origin redirect stays blocked.
   - Append `Content-Security-Policy: script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'` to `main_frame` and `sub_frame`, at a priority above the allow rule.
   - Register the origin agent: a runtime content script, top frame, `document_start`, the target origin only, `persistAcrossSessions: false`.
5. Navigate. The document commits, but its scripts are blocked, and the agent connects over a port with structured clone. The background accepts the port only from the managed tab, the barrier navigation's `documentId`, the target origin, and the current operation id and generation.
6. The agent restores Web Storage and IndexedDB, and answers `restored` only after every transaction completes and every connection closes. It refuses an origin that already holds data.
7. Remove the barrier and check that Chrome lists no rule or script, then reload the same tab. Wait for a commit with a new `documentId` on the target origin, then release.

Any failure after the window exists records the operation as failed with its step, closes the window (so a partly restored identity is never used), removes the barrier, and shows "Start with an identity failed at the <step> step. <reason>" in the dashboard. The running operation is journaled in `local:workspace-operation`. When the service worker starts, an unfinished one is recorded as interrupted and cleaned up.

### Barrier proof (S2.6, `tests/e2e/poc-barrier.spec.ts`)

The run is `POC_REPEATS=50`, 50 cycles per delay (`.artifacts/docker/2026-10-28T15-22-37.170Z-fd7a8577-8aa5-41f8-8afa-7257624e347c`).

| Check, every cycle                                                                          | Result                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The application's first reads (synchronous inline `<head>` script, then its IndexedDB read) | Equal the restored cookie, localStorage, sessionStorage, and IndexedDB record                                                                                           |
| Requests the server saw before the release                                                  | Only `/app/redirect` and the barrier's `/app/` document, both carrying exactly the restored cookie names. No module, worker, subframe, image, fetch, favicon, or beacon |
| Site CSP (`?csp=1`, on the final document) after the release                                | Still enforced: the `script-src-elem` violation the site's policy forbids still fires                                                                                   |
| `navigator.serviceWorker.controller` at bootstrap                                           | `null`                                                                                                                                                                  |
| Normal profile's cookie store                                                               | Unchanged                                                                                                                                                               |
| Rules and scripts after the release                                                         | None listed                                                                                                                                                             |
| Redirect from the target to `other.localhost:5192` under the barrier                        | The start fails explicitly, the window closes, nothing is released                                                                                                      |
| Negative control (scratch worktree): no barrier rules, restore held 2,000 ms                | The application runs first. Its first reads are empty (`idbRecord: null`, empty storages), and the restore refuses the now non-empty origin (`OriginNotEmpty`)          |

Step timings in ms (min / median / p95 / max), with the 2,000 ms hold excluded:

| Step                                     | Delay 0 ms                | Delay 2,000 ms            |
| ---------------------------------------- | ------------------------- | ------------------------- |
| store-gone (wait for no Incognito store) | 0.0 / 0.2 / 0.2 / 0.3     | 0.0 / 0.1 / 0.3 / 0.4     |
| window                                   | 25.6 / 27.4 / 32.9 / 43.9 | 27.0 / 29.4 / 41.1 / 45.7 |
| cookie-store                             | 7.3 / 9.9 / 12.6 / 13.9   | 5.8 / 10.2 / 14.8 / 18.9  |
| cookies                                  | 3.6 / 6.1 / 9.0 / 13.0    | 3.5 / 6.8 / 14.0 / 15.5   |
| barrier                                  | 1.3 / 1.7 / 4.5 / 6.7     | 1.4 / 1.9 / 4.9 / 9.7     |
| navigate                                 | 14.1 / 16.6 / 21.5 / 24.1 | 14.2 / 16.7 / 24.6 / 27.6 |
| restore                                  | 23.0 / 25.2 / 30.8 / 34.5 | 4.0 / 13.4 / 19.1 / 23.7  |
| unbarrier                                | 1.0 / 1.2 / 4.4 / 5.8     | 1.1 / 2.7 / 4.1 / 4.8     |
| reload                                   | 7.5 / 9.2 / 13.6 / 14.9   | 7.6 / 14.1 / 17.1 / 26.8  |
| Total per cycle (median / max)           | 97.5 / 142.0              | 95.2 / 137.1              |

The store wait always ended after one listing. The old Incognito store was already gone by the time no Incognito window was listed, so the wait was never under pressure in these runs.

### Failure paths (S2.7, `tests/e2e/poc-failure.spec.ts`)

| Case                                           | Observed                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore failure injected                       | Dashboard alert names the step and the reason. No Incognito window, no rule, no script. The server saw only the redirect and the barrier document, with no beacon                                                                                        |
| Tab closed during the held restore             | Same. Chrome threw "Extension context invalidated" on the port instead of firing `onDisconnect`, so the start now fails as `AgentDisconnected`, "The page closed before its data was restored."                                                          |
| Service worker stopped during the held restore | Session rules and the registered script survive the stop. On restart the journal is recorded as interrupted at its step, and recovery closes the window (only if it is still that generation's managed window, since Chrome reuses ids) and removes both |

Each case passed 5 of 5 (`--repeat-each 5`). Scratch copies without the journal watch or without recovery left the alert missing, and in the second case 4 rules, 1 script and the window behind.

### Findings outside the POC's goal

- **Session-control flake introduced by S1.5, fixed in tests (S2.4a).** "Closing the PiP window keeps the session…" passed 20 of 20 on the base and failed 2 of 20 after S1.5 (6 of 40 under a probe). The recorded tab now lives in the Incognito window, and a PiP that opens after the test focuses that tab keeps the focus, so the test's focused-window helper read the PiP's tab. The helpers now read the active tab of the browsing window Chrome focused last. After the fix, 40 of 40 passed and the whole spec passed 90 of 90.
- **Vitest UI writes to the test origin's localStorage** (`vitest-ui_task-tree-opened`), so the Browser Mode tests use in-memory Web Storage. A `deleteDatabase` "blocked" check was unreliable, so the tests count `IDBDatabase.close` calls instead.

### Not shown by Stage 2

- **A real extension reload.** In the test Chromium, `chrome.runtime.reload()` unloads the command-line extension for good. The interrupted case stops the service worker through DevTools instead, which is the realistic worker-termination path, but not an update or reload.
- **The store wait under pressure.** It never had to wait.
- **Only the start with an identity waits for the store.** Stage 1's Start, Close and start, and Close and start empty do not. Stage 3's coordinator should route every window creation through the same sequence.
- **No user-facing entry point yet.** The start with an identity is reachable only through the test-only `recnrunPoc` handles. Stage 3 connects it to saved identities.
- **Frames and workers under the barrier.** Their requests were blocked, but none could start while scripts were blocked, so no frame or worker ran under it.
- **Browser restart during a start.** Recovery after a full browser restart, racing Chrome's startup window bookkeeping, was not tested. S3.11 covers browser restarts.
- **Real applications.** Only the fixture app; Stage 4 covers the PWA and Zephyr.

## 7. Stage 3: fidelity and consistency

_pending_

## 8. Stage 4: PWA and Zephyr

_pending_

## 9. Timings

_pending_

## 10. Supported claims and non-claims

_pending_

## 11. Recommendation

_pending_
