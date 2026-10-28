# POC report: origin snapshots in sequential Incognito sessions

Status: **Stage 0 done; Stage 1 not started.** Plan: [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md). Assignment: [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md). Checklist: [poc-incognito-sessions-checklist.md](poc-incognito-sessions-checklist.md).

## 1. Verdicts

| Area                    | Verdict   | Evidence |
| ----------------------- | --------- | -------- |
| Native reset            | _pending_ |          |
| Data fidelity           | _pending_ |          |
| Startup barrier         | _pending_ |          |
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

Production: unchanged (`storage`, `tabs`, `incognito: "spanning"`), per decision OD-1. Test and development builds: _added per task; listed here as they land._

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
| Cookie store after the last Incognito window closes                                                      | Store `"1"` was already gone when `windows.onRemoved` fired (6 ms after `windows.remove`). Whether all other teardown is complete by then is Stage 1's question                      |

Not shown by this probe: whether the appended CSP keeps a site's own CSP in force (the `?csp=1` header was on the redirect response, not the final document), workers and subframes, a Service Worker serving the document (none exists in a fresh context), and repeated runs. Stage 2 covers them.

## 5. Stage 1: native reset

_pending_

## 6. Stage 2: startup barrier

_pending_

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
