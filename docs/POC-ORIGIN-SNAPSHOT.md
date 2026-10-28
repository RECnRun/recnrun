# POC report: origin snapshots in sequential Incognito sessions

Status: **Stage 3 done; Stage 4 next.** Gates G1 and G2 passed (go-ahead 2026-10-28); Gate G3 stops only on a NO-GO. Plan: [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md). Assignment: [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md). Checklist: [poc-incognito-sessions-checklist.md](poc-incognito-sessions-checklist.md).

## 1. Verdicts

| Area                    | Verdict              | Evidence |
| ----------------------- | -------------------- | -------- |
| Native reset            | **GO**               | §5       |
| Data fidelity           | **GO**               | §7       |
| Startup barrier         | **GO**               | §6       |
| Capture consistency     | **GO**, per database | §7       |
| Local PWA compatibility | _pending_            |          |
| Zephyr                  | _pending_            |          |

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

| Build             | `permissions`                                                                                           | `host_permissions`                                                                                                                                                                                                                                                                                                                                                                       | Other                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production        | `storage`, `tabs` (unchanged)                                                                           | none                                                                                                                                                                                                                                                                                                                                                                                     | `incognito: "spanning"`; no `message_serialization`; no origin agent script; no `recnrunPoc` test handles                                                         |
| Test (Docker e2e) | `storage`, `tabs`, `declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, `unlimitedStorage` | `http://*.localhost/*`, `https://*.localhost/*` (S3.6: `cookies.getAll` hides a `Secure` cookie without https access)                                                                                                                                                                                                                                                                    | `message_serialization: "structured_clone"`; `content-scripts/origin-agent.js` (runtime-registered, not in `content_scripts`); `recnrunPoc` on the service worker |
| Development       | as test                                                                                                 | as test, plus each `RECNRUN_POC_HOSTS` host and every parent domain of two or more labels, as `https://<d>/*` and `http://<d>/*` without a port (S3.12a). For Zephyr: `zephyr-tq.one.be`, `login-acc.one.be`, `one.be`. Without a public suffix list, a multi-label suffix such as `co.uk` would also be granted; Chrome stores no cookie there, but it is wider page access than needed | as test, without `recnrunPoc`                                                                                                                                     |

## 4. Stage 0: platform facts (P0.2)

Throwaway probe in a scratch worktree (nothing committed): the test build gained `declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, host access `http://*.localhost/*`, `"message_serialization": "structured_clone"`, and a WXT content script with `registration: "runtime"`. One Playwright spec (`incognitoAccess: true`) ran a local server on `app.localhost:5191`; the service worker created an Incognito window on `about:blank`, then did everything below. Command: `vp run test:e2e -- tests/e2e/zz-probe.spec.ts` (scratch copy, Docker), one run.

| Question                                                                                                 | Observed                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WXT keeps `message_serialization` in the built manifest                                                  | Yes: `runtime.getManifest().message_serialization === "structured_clone"`                                                                                                                                     |
| A port from an Incognito content script to the spanning worker carries structured values                 | Yes: `Date`, `Blob` (type and content), `ArrayBuffer`, `Uint16Array`, `Map`, and a 12 MiB string in one message arrived intact                                                                                |
| The port's sender identifies tab, document, origin                                                       | Yes: `sender.tab.id`, `sender.documentId`, `sender.origin` (`http://app.localhost:5191`), `sender.tab.incognito === true`                                                                                     |
| `registration: "runtime"` entrypoint                                                                     | Emitted as `content-scripts/probe.js`, absent from the manifest's `content_scripts`; `scripting.registerContentScripts` ran it at `document_start` in the Incognito tab                                       |
| Cookie store of the Incognito tab                                                                        | `getAllCookieStores()` listed store `"1"` with the new tab's id; `cookies.set` with that `storeId` reached the page (`document.cookie === "probe=v"`) and not the normal store `"0"`                          |
| DNR session rule with `tabIds` appending `Content-Security-Policy: script-src 'none'; worker-src 'none'` | Applied in Incognito, through a 302 redirect: neither the inline script nor the module script ran, while the isolated-world script wrote `localStorage` on the origin                                         |
| DNR block of every non-`main_frame` request for the tab                                                  | The server saw only `/redirect?csp=1` and `/page`: no module, no image request                                                                                                                                |
| Removing rules and scripts                                                                               | `getSessionRules()` and `getRegisteredContentScripts()` empty afterwards                                                                                                                                      |
| Cookie store after the last Incognito window closes                                                      | Gone 6 ms after `windows.remove` in this single run. Corrected by S1.7 (order) and by Chromium's source (meaning): the listing drops a store when its last tab closes, not when the profile is destroyed (§5) |

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

**Risk carried into Stage 2, and what Chromium's source says about it.** The product did not wait for anything after `onRemoved`; the margin between the store going and the next create was 0.4–1.4 ms. Reading Chromium 156.0.8078.4 (the tested version) shows the cookie-store listing was the wrong signal:

- `cookies.getAllCookieStores()` lists only stores that have an open tab (`chrome/browser/extensions/api/cookies/cookies_api.cc:895-904`), so a missing Incognito store proves only that the last Incognito tab closed.
- When the last Incognito browser closes, Chrome destroys the off-the-record profile only after its render processes exit, or after a 1 s timeout (`browser_manager_service.cc:145-161`; `profile_destroyer.cc:36-37, 335-343, 395-411`), and only then erases it (`profile_impl.cc:1094-1098`).
- Until it is erased, `windows.create({ incognito: true })` gets the existing profile back (`tabs_api.cc:1044-1047`, `GetPrimaryOTRProfile(true)`; `profile_impl.cc:1063-1066`): a create in that interval reuses the dying session and its data.

So the 50 of 50 above shows that renderers exited fast in these runs, not that a create right after `onRemoved` is always empty. The observable signal of an erased profile is a cookie call naming the old store id: `cookies.getAll({ storeId })` fails with "Invalid cookie store id" once the profile is gone, because the lookup never creates one (`cookies_helpers.cc:81-98`; `chrome_extensions_browser_client.cc:322-325`; `cookies_api.cc:63, 103-115`).

**Correction (S2.5a, `a0ee35a`).** RECnRun remembers every Incognito store id it sees (`local:incognito-store-ids`, ids only), and before every window creation (Start, Close these windows and start, Close and start empty, the identity bootstrap, and every Stage 3 lifecycle command) it waits until no Incognito store is listed **and** `cookies.getAll` rejects for every remembered id, bounded at 10 s (`IncognitoNotGone`). The verdict stays **GO** on that basis. Two gaps found here were fixed in Stage 3: an Incognito window the user opens and closes between two commands is now remembered from `tabs.onCreated` (S3.12g, `3d444ea`), and builds without the `cookies` permission (production, OD-1) show the workspace as unavailable and refuse every command before any side effect (S2.5b, `09487be`).

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

1. Wait until Chrome destroyed the previous Incognito profile: no Incognito store listed and `cookies.getAll` rejects for every remembered store id (S2.5a; the original step checked only the listing, see §5).
2. Create RECnRun's Incognito window on `about:blank`, then find the cookie store whose `tabIds` hold the managed tab. The id is never `"0"` or a constant.
3. Set the identity's cookies, HttpOnly ones included, with that `storeId`.
4. Install the barrier: four DNR session rules scoped to the managed tab.
   - Block every request type but `main_frame`.
   - Block `main_frame`, and allow it again only on the target origin. An off-origin redirect stays blocked.
   - Append `Content-Security-Policy: script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'` to `main_frame` and `sub_frame`, at a priority above the allow rule.
   - Register the origin agent: a runtime content script, top frame, `document_start`, the target origin only, `persistAcrossSessions: false`.
5. Navigate. The document commits, but its scripts are blocked, and the agent connects over a port with structured clone. The background accepts the port only from the managed tab, the barrier navigation's `documentId`, the target origin, and the current operation id and generation.
6. The agent restores Web Storage and IndexedDB, and answers `restored` only after every transaction completes and every connection closes. It refuses an origin that already holds data.
7. Remove the barrier and check that Chrome lists no rule or script, then reload the same tab from inside the barrier's document (`scripting.executeScript` on its `documentId`, `location.reload()`; S3.7a). Wait for a commit with a new `documentId` on the target origin, then release.

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

The store wait always ended after one listing. The old Incognito store was already gone by the time no Incognito window was listed, so the wait was never under pressure in these runs. These timings predate S2.5a, which adds the per-id probe to this step.

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
- **The teardown wait under pressure.** It never had to wait. Since S2.5a it waits for the profile's erasure (§5), which Chromium's source, not a measurement, shows is the right signal.
- ~~Only the start with an identity waits for the store.~~ Since S2.5a every window creation waits.
- ~~No user-facing entry point yet.~~ S3.8 and S3.9 connect it to saved identities in the dashboard (§7).
- **Frames and workers under the barrier.** Their requests were blocked, but none could start while scripts were blocked, so no frame or worker ran under it.
- **Browser restart during a start.** Recovery after a full browser restart, racing Chrome's startup window bookkeeping, was not tested. S3.11 covers browser restarts.
- **Real applications.** Only the fixture app; Stage 4 covers the PWA and Zephyr.

## 7. Stage 3: fidelity and consistency

Verdicts: **data fidelity GO**, with the losses listed below, every one either reported by the capture or proved unobservable by the page; **capture consistency GO for one database at a time**, not across databases or storage kinds. Stage 3 `vp run verify`: exit 0 on `8f2647e`, 485 unit and component tests, 86 of 86 end-to-end, coverage 98.99% statements and 96.28% branches (`.artifacts/docker/2026-10-28T21-09-29.348Z-0afb40df-8ffb-472d-8002-6ddcc43b41f4`).

### What was built (S3.1–S3.9, S3.12)

- **Format.** `IdentityCapture` v1 in `@recnrun/domain` (`formatVersion` 1, separate from `Snapshot`): cookies, and per origin Web Storage, IndexedDB with schema and indexes, and Cache Storage, plus `unsupported` items named without values.
- **Storage.** Extension IndexedDB `recnrun-identity-captures` (`unlimitedStorage` in test and development builds). A capture is written in parts and published in one transaction. Since S3.12d it is published tentatively and settled only when the identity's `lastCapture` names it, so a failed or interrupted persist puts the previous capture back.
- **Transport.** Page agent ↔ service worker over a port with `message_serialization: "structured_clone"`, probed with a `Date` round trip on every link before any payload (S3.4a). Without that manifest key the probe fails as `StructuredCloneUnavailable`.
- **Lifecycle (S3.8).** Switch to, Suspend, Resume, New identity, Delete, one at a time under the workspace lock, each step journaled. The open identity is captured and saved before its window closes. Since S3.12e the target's capture is read and validated before anything is touched, and since S3.12f the backend refuses while the managed window has other tabs.
- **Dashboard (S3.9).** Saved identities with time and approximate size, one command per row, a conflict banner that disables every command but Delete when another Incognito window or tab is open, and one alert per failure naming the step.

### Fidelity, per storage kind

Every case is an end-to-end round trip: write in the Incognito page, capture, close, start from capture in a new Incognito session, read back in the released page.

| Kind                   | Came back exactly                                                                                                                                                                                                                                   | Lost or changed, and how it surfaces                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IndexedDB (S3.3, S3.4) | Databases, versions, stores, key paths, indexes (`unique`, `multiEntry`), keys, and values: `Date`, `Blob` and `File` with type, `ArrayBuffer`, typed arrays with `-0` and `NaN`, `DataView`, `Map`, `Set`, `undefined`, an 8 MiB record            | An `autoIncrement` store's next key is not carried: the source would issue 4, the restored store issues 3. A Blob from the Incognito page cannot be written to the extension's IndexedDB (`InvalidBlob`: the Blob registry is per browser context, `storage/browser/blob/blob_storage_context.cc:727-738`), so its bytes are copied first (`own-blobs.ts`)                                                              |
| Web Storage (S3.5)     | localStorage and sessionStorage: keys `__proto__`, `constructor`, `""`, lone surrogates, empty values, 2,000,000-character values                                                                                                                   | Nothing observed                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cookies (S3.6, S3.6a)  | Every attribute: HttpOnly, Secure, SameSite, session, expiry to the microsecond, path shadowing, `__Host-`/`__Secure-`, partitioned (first-party and cross-site key), and domain cookies (`hostOnly:false`, sent to the sibling host after restore) | Cookies of hosts outside the target and its declared hosts go to `unsupported`. A cookie expired since capture is skipped, as Chrome would not store it. Cookies the host permissions hide fail the capture by name when the page can see them (`CookiesNotReadable`, S3.12a); an HttpOnly cookie outside the permissions cannot be detected, so the development build grants every parent domain the cookies need (§3) |
| Cache Storage (S3.7)   | Caches in order, keys, request headers, status, status text, response headers, bodies (4 MiB binary by SHA-256), `Vary` matching                                                                                                                    | Opaque and opaque-redirect entries cannot be rebuilt and go to `unsupported`. A rebuilt response reads as type `default`, `url` `""`, `redirected` false (`fetch_response_data.cc:279-284`, `response.cc:482-494`). Unobservable by the page, from source only: a CORS entry's hidden headers                                                                                                                           |
| First request (S3.7a)  | The released document's request carries every restored cookie, `SameSite=Strict` included, because its reload is started by the barrier's own document (`location.cc:262-272`, `frame_load_request.cc:97-101`)                                      | The barrier document's own request lacks Strict cookies (`tabs.update` makes the extension the initiator, `tabs_api.cc:2966-2971`); only the agent runs in that document                                                                                                                                                                                                                                                |

The cookie row needs a correction to an earlier statement of this POC: `localhost` is not in the public suffix list, but Chrome treats an unlisted top-level domain as a one-label registry (`net/base/registry_controlled_domains/registry_controlled_domain.cc:188-195, 308`), so `app.localhost` is registrable and `Domain=app.localhost` makes a real domain cookie. A scratch probe on a listed suffix (`*.recnrun-poc.be` through `--host-resolver-rules`) confirmed the same behaviour and the permission rule: `cookies.getAll` keeps a cookie only with page access to its bare domain, with `https` only when the cookie is `Secure` and no port (`chrome/browser/extensions/api/cookies/cookies_helpers.cc:51-56, 201-206`; `net/cookies/cookie_util.cc:664-692`). Before S3.12a, host patterns limited to `zephyr-tq.one.be` and `login-acc.one.be` lost every `.one.be` cookie without a word.

### Consistency boundary (S3.10)

A page, a dedicated worker, and a Service Worker each wrote every ~10 ms during the captures (20 runs × 3 restores). Capture step min 11, median 15, p95 21, max 24 ms.

- **Supported:** each IndexedDB database comes back as one state that existed. The capture reads it in one `readonly` transaction; a writer's `readwrite` transaction on an overlapping store waits for it and commits after it (`content/browser/indexed_db/instance/database.cc:74-104`, `:108-138`, chosen at `:243-244`). Every write committed before the capture started is in it; every write committed after the capture was published is not.
- **Not supported:** atomicity across databases or across storage kinds. Databases are read one after another, after Web Storage. The page's database and a mirror database differed in 5 of 60 restores, and the database and localStorage in 8 of 60. An application that keeps one invariant across two of them can come back in a state that never existed at once. Making it atomic would need the application's cooperation, since RECnRun cannot pause a page, a worker and a Service Worker without changing them.
- **Lost by design:** writes committed after their database was read, up to the window's close: 0–2 per writer at a 10 ms write rate.

### Lifecycle (S3.8, S3.11, S3.12)

| Scenario                                                       | Result                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A→B→A→C→A ×10 (`2026-10-28T20-09-58.428Z-c402de22`)            | 41 openings, 40 switches, every identity read back exactly its own last marker in cookie, localStorage, sessionStorage and IndexedDB; a new identity read nothing; the normal profile unchanged. Switch median 137 ms, p95 153, max 157 |
| 10,000 IndexedDB records (`2026-10-28T20-02-19.386Z-24ff228b`) | Capture 4.46 MB (~446 B per record) in 70 ms; restore 168 ms                                                                                                                                                                            |
| Two dashboards at once                                         | One runs; the other gets "RECnRun is busy with another Incognito workspace"                                                                                                                                                             |
| A user's Incognito window or tab                               | Before a command: refused with nothing done. During a capture: the capture is saved, the window is not closed, the user's window is untouched                                                                                           |
| Broken target capture (bad schema, incomplete, missing)        | Refused before anything is captured or closed (S3.12e)                                                                                                                                                                                  |
| A step fails (capture, persist, restore)                       | Capture or persist failing keeps the open window and the previous capture (S3.12d); restore failing leaves no window or barrier, and the next Resume works                                                                              |
| Tab closed during capture or restore                           | The command fails at its step; nothing is left open                                                                                                                                                                                     |
| Extension restart during capture or restore                    | Recovery names the interrupted command (S3.12b) and closes RECnRun's own window of that generation, never a foreign one (S3.12c); no barrier rule or script remains                                                                     |
| Stale agent replies replayed into every command                | Dropped by the operation id and generation check; every marker right                                                                                                                                                                    |
| Browser restart                                                | Saved identities resume; an identity that was open but never saved has no data, since Chrome discards Incognito data at exit                                                                                                            |

Per-step medians in the rounds, ms: capture 6, persist 1, close 16, store-gone 1, window 3, cookie-store 3, cookies 1, barrier 2, navigate 15, restore 7, unbarrier 2, reload 12.

### Defects found and fixed in this stage

Each with a red/green test (evidence in the checklist): Strict cookies missing on the released document (S3.7a); the teardown signal (S2.5a, §5); production showing commands that could only fail (S2.5b); the silent loss of domain cookies (S3.12a); the recovery message naming "start" for a switch (S3.12b); a window left open after a restart during a capture (S3.12c); a capture left published after a failed persist (S3.12d); a switch to a broken capture closing the open identity first (S3.12e); a second tab in the managed window refused only by the UI (S3.12f); an Incognito window opened and closed outside RECnRun not waited for (S3.12g).

### Limits that are not defects

- **Data written after the last capture is lost** when the user closes the tab or the browser exits: Chrome discards the Incognito session with its last window, and a capture cannot run once the renderer is gone. A mitigation without new permissions, not built: capture again after each top-level navigation in the managed tab and when its window loses focus, debounced and skipped while a command runs.
- **Storage of a second origin.** Only the managed tab's top-level origin is captured. An SSO provider on another origin is covered through its cookies (the usual case), not its localStorage or IndexedDB; Stage 4 (S4.3) tests a cross-site SSO.

### Not shown by Stage 3

- A real HTTPS registrable domain end to end in the committed tests (the `.recnrun-poc.be` probe was scratch and over http, so `Secure`, `SameSite=None` and partitioned domain cookies on a listed suffix were not exercised).
- Host Chrome on macOS; every run was Chrome for Testing 156 on Linux.
- A real application: Stage 4.

## 8. Stage 4: PWA and Zephyr

_pending_

## 9. Timings

_pending_

## 10. Supported claims and non-claims

_pending_

## 11. Recommendation

_pending_
