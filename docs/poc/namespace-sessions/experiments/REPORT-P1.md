# P1 report: which route reaches which capability

Task P1.8 of [PLAN.md](../PLAN.md#p1-minimal-service-worker-proof-source-5-14-deliverable-2). P1 asked whether branded Chrome lets the extension run its bootstrap before the first statement of a page or worker, stop a service worker, and control its restart, through three routes: Route A (`chrome.debugger` pauses the target and evaluates the bootstrap), Route B (`Fetch` fulfils the service-worker script with a wrapper), and Route C (MAIN-world content scripts for pages, wrapped or refused `Worker` and `SharedWorker`). Result: Google Chrome 156.0.8078.79 on Linux in Docker, load method `cdp-load-unpacked`, 2026-11-03. Nothing here is validated on macOS or Windows. This report does not pick a route: the owner does, per capability, from the output below, and records the decision in [CHECKLIST.md](../CHECKLIST.md).

The report is hand-written around one generated block. `scripts/decide.mjs` maps each hypothesis of [E2](E2.md) to [E8](E8.md) to a capability and a route (`scripts/decide-mapping.mjs`, one reason per row) and prints the tables; `vp run docs:check` fails when the block differs from a fresh run against the committed verdicts, and `node scripts/decide.mjs --write` refreshes it. [E0](E0.md) and [E1](E1.md) probe what Chrome allows and feed no cell, nor does E8's `d-other-clients`, a precondition of the strict lab.

## Evidence run

- Run `2026-11-03T16-06-00.096Z-5d1d0abc-d0e5-4c37-8445-ac63d60f00c1`, taken from commit `aadb891` with `vp run test:experiments`: 18 specs passed in 36.7 min, Google Chrome 156.0.8078.79 on Linux in Docker (E0's diagnostic hypothesis `c` ran on Chrome for Testing 156.0.8078.4 and is not counted). Its 70 verdicts (none with a `mode` field, so none from `verify`'s smoke run) are committed per experiment under [verdicts/](verdicts/), verbatim from the run's redacted `verdicts.json`.
- The runs the E-reports cite came from agent worktrees that no longer exist; their verdict files are gone. This run replaces them as the committed evidence, and the E-reports are unchanged. Where a count differs from its report:

| Hypothesis                       | Item                                  | E-report (run)          | This run |
| -------------------------------- | ------------------------------------- | ----------------------- | -------- |
| E3 `cold-start-navigation`       | passed samples of 200                 | 17, 11, 12 (A, B, C)    | 0        |
| E3 `cold-start-navigation`       | late attaches                         | 163, 149, 184 (A, B, C) | 199      |
| E4 `close-target`                | failed samples of 29                  | 24, 26 (A, B)           | 25       |
| E4 `close-target`                | `restartObservedBeforeFirstStatement` | 5, 3 (A, B)             | 4        |
| E4 `close-target`, `held`        | samples passed of 10                  | 2, 0 (A, B)             | 0        |
| E4 `close-target`, `held-module` | samples passed of 3                   | 3 (A and B)             | 2        |

The `held-module` sample lost is the navigation trigger (E4.md: 1 of 1; this run: 0 of 1). Everything else I compared equals the report: E2 (first effect before the marker 100, 10, and 10; `patchSkipped` 100 and 10), E3 `before-script-execution` (120 of 120, late 0), `direct-attach-race` (1 of 120, late 119; run C of E3.md), `pre-existing-running`, `wake-without-tab`, the E4 mechanisms other than `close-target`, E5 (every row), E6 (run C), and E7. Timings are not compared. E0 and E1 are not compared (not mapped).

- The stress runs of E3 and E6 (`vp run test:stress`) belong to the Gate P1 and are not available yet: the orchestrator copies the gate's `stress.json` to `experiments/verdicts/stress.json`, and `scripts/decide.mjs` then prints it in place of `stress: not recorded`.
- Confound, for every Route A row: the harness connects through Playwright's `connectOverCDP`, which sets a browser-level `Target.setAutoAttach` with `waitForDebuggerOnStart`, so each worker has a second DevTools client ([E3](E3.md#observations), [E4](E4.md#observations)). Inferred from Chromium's source and not verified: a DevTools-attached worker skips the idle timeout and a restart reuses its target. Without it, Route A's race and restart results could be better or worse; no run without it exists. The manual item M-P1.a has a lab result on DevTools coexistence ([MANUAL_VALIDATION.md](../MANUAL_VALIDATION.md), spec [`devtools-coexistence.spec.ts`](../../../../tests/browser/devtools-coexistence.spec.ts), which is not an experiment and writes no verdict); the person's check is still open.

## Decision output

<!-- decide:start -->

Chrome: Google Chrome 156.0.8078.79 (73 verdicts); Google Chrome for Testing 156.0.8078.4 (1 verdict)

**Which route passed, per capability**

| Capability            | Route A                               | Route B    | Route C                       |
| --------------------- | ------------------------------------- | ---------- | ----------------------------- |
| page                  | not tested                            | not tested | mixed (3 pass, 3 unavailable) |
| dedicated             | mixed (1 pass, 2 fail, 1 unavailable) | pass (3)   | fail (1)                      |
| shared                | fail (1)                              | pass (3)   | fail (2)                      |
| serviceWorker.first   | mixed (2 pass, 2 fail)                | fail (2)   | not tested                    |
| serviceWorker.update  | not tested                            | fail (2)   | not tested                    |
| serviceWorker.cold    | mixed (1 pass, 6 fail)                | pass (1)   | not tested                    |
| serviceWorker.offline | not tested                            | fail (2)   | not tested                    |
| serviceWorker.wake    | unavailable (1)                       | not tested | not tested                    |

**Capabilities per route**

| Route   | Pass | Mixed | Fail | Unavailable | Not tested |
| ------- | ---- | ----- | ---- | ----------- | ---------- |
| Route A | 0    | 3     | 1    | 1           | 3          |
| Route B | 3    | 0     | 3    | 0           | 2          |
| Route C | 0    | 1     | 2    | 0           | 5          |

**Evidence behind each cell** (diagnostic, control, and supporting rows are not counted)

| Capability            | Route | Hypothesis                               | Verdict           | Spec                                               | Reason                                                                                    |
| --------------------- | ----- | ---------------------------------------- | ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| serviceWorker.first   | A     | E2 service-worker-register               | fail              | tests/experiments/E2-route-a-register.spec.ts      | auto-attach before register(); caches is undefined at the pause                           |
| serviceWorker.first   | A     | E3 before-script-execution [sw-*]        | pass              | tests/experiments/E3-route-a-cold.spec.ts          | armed tab, auto-attach and a breakpoint hold each worker                                  |
| serviceWorker.first   | A     | E3 direct-attach-race [sw-*]             | fail              | tests/experiments/E3-route-a-cold.spec.ts          | attaching by target id as getTargets() lists it loses the race                            |
| serviceWorker.first   | A     | E8 a-cold-start                          | pass              | tests/experiments/E8-strict.spec.ts                | the same hold in Chrome without CDP, the isolator installed by policy                     |
| dedicated             | A     | E2 dedicated-worker                      | fail              | tests/experiments/E2-route-a-register.spec.ts      | auto-attach before the worker starts; caches is undefined at the pause                    |
| dedicated             | A     | E2 nested-worker                         | unavailable       | tests/experiments/E2-route-a-register.spec.ts      | the frozen fixture starts no worker from a worker                                         |
| dedicated             | A     | E3 before-script-execution [dedicated-*] | pass              | tests/experiments/E3-route-a-cold.spec.ts          | armed tab, auto-attach and a breakpoint hold each worker                                  |
| dedicated             | A     | E3 direct-attach-race [dedicated-*]      | fail              | tests/experiments/E3-route-a-cold.spec.ts          | attaching by target id loses the race                                                     |
| shared                | A     | E2 shared-worker                         | fail              | tests/experiments/E2-route-a-register.spec.ts      | a tab session never auto-attaches shared workers (E1)                                     |
| serviceWorker.cold    | A     | E3 cold-start-navigation                 | fail              | tests/experiments/E3-route-a-cold.spec.ts          | a navigation restarts a worker the isolator stopped                                       |
| serviceWorker.cold    | A     | E3 pre-existing-running                  | fail              | tests/experiments/E3-route-a-cold.spec.ts          | a worker already running when Route A arrives                                             |
| serviceWorker.cold    | A     | E4 close-target                          | fail              | tests/experiments/E4-stop-restart.spec.ts          | Target.closeTarget stops the worker; the restart must be caught                           |
| serviceWorker.cold    | A     | E4 terminate-execution                   | fail              | tests/experiments/E4-stop-restart.spec.ts          | Runtime.terminateExecution is refused to untrusted clients                                |
| serviceWorker.cold    | A     | E4 debugger-pause                        | pass (supporting) | tests/experiments/E4-stop-restart.spec.ts          | a pause holds the worker without stopping it; it proves no restart was caught             |
| serviceWorker.cold    | A     | E4 dnr-block-evict                       | fail              | tests/experiments/E4-stop-restart.spec.ts          | a DNR block does not evict a running worker                                               |
| serviceWorker.cold    | A     | E4 unregister                            | fail              | tests/experiments/E4-stop-restart.spec.ts          | unregister() leaves the target listed                                                     |
| serviceWorker.cold    | A     | E8 b-restart                             | pass              | tests/experiments/E8-strict.spec.ts                | without CDP a reload after closeTarget restarts the worker marked                         |
| serviceWorker.wake    | A     | E3 wake-without-tab                      | unavailable       | tests/experiments/E3-route-a-cold.spec.ts          | a worker woken with no tab open is attached by watch                                      |
| serviceWorker.first   | B     | E5 first                                 | fail              | tests/experiments/E5-route-b-fetch.spec.ts         | the main script is fulfilled with the wrapper on the first registration                   |
| serviceWorker.first   | B     | E5 imports                               | pass (supporting) | tests/experiments/E5-route-b-fetch.spec.ts         | importScripts and static imports pause on the worker session; interception, not isolation |
| serviceWorker.first   | B     | E5 imports-transform                     | pass (diagnostic) | tests/experiments/E5-route-b-fetch.spec.ts         | imports fulfilled too                                                                     |
| serviceWorker.first   | B     | E5 tab-session-main-script               | fail (diagnostic) | tests/experiments/E5-route-b-fetch.spec.ts         | the main script never pauses on the tab session                                           |
| serviceWorker.first   | B     | E6 a-switch                              | fail              | tests/experiments/E6-route-b-selection.spec.ts     | a slot switch without rewriting the stored script                                         |
| serviceWorker.update  | B     | E5 update                                | fail              | tests/experiments/E5-route-b-fetch.spec.ts         | the update check is not interceptable                                                     |
| serviceWorker.update  | B     | E6 b-update                              | fail              | tests/experiments/E6-route-b-selection.spec.ts     | the namespace survives update()                                                           |
| serviceWorker.cold    | B     | E6 restart                               | pass              | tests/experiments/E6-route-b-selection.spec.ts     | Chrome relaunched on the profile keeps the stored wrapper                                 |
| serviceWorker.offline | B     | E5 offline                               | fail              | tests/experiments/E5-route-b-fetch.spec.ts         | a stopped worker restarts offline from the stored wrapper                                 |
| serviceWorker.offline | B     | E5 fulfilled-worker-address-space        | fail (diagnostic) | tests/experiments/E5-route-b-fetch.spec.ts         | a fulfilled worker leaves from Unknown                                                    |
| serviceWorker.offline | B     | E6 a-offline                             | fail              | tests/experiments/E6-route-b-selection.spec.ts     | a slot switch while the fixture is offline                                                |
| dedicated             | B     | E6 c-workers [dedicated:*]               | pass              | tests/experiments/E6-route-b-selection.spec.ts     | the slot switch reaches dedicated workers                                                 |
| dedicated             | B     | E6 suspend [dedicated:*]                 | pass              | tests/experiments/E6-route-b-selection.spec.ts     | dedicated workers survive a suspended background                                          |
| dedicated             | B     | E8 c-selection-workers [dedicated:*]     | pass              | tests/experiments/E8-strict.spec.ts                | the same switch in Chrome without CDP                                                     |
| shared                | B     | E6 c-workers [shared:*]                  | pass              | tests/experiments/E6-route-b-selection.spec.ts     | the slot switch reaches shared workers                                                    |
| shared                | B     | E6 suspend [shared:*]                    | pass              | tests/experiments/E6-route-b-selection.spec.ts     | shared workers survive a suspended background                                             |
| shared                | B     | E8 c-selection-workers [shared:*]        | pass              | tests/experiments/E8-strict.spec.ts                | the same switch in Chrome without CDP                                                     |
| page                  | C     | E7 page                                  | pass              | tests/experiments/E7-route-c-pages-workers.spec.ts | a registered content script marks the page before its first script                        |
| page                  | C     | E7 cross-site-iframe                     | pass              | tests/experiments/E7-route-c-pages-workers.spec.ts | a cross-site frame is marked only when its origin is registered                           |
| page                  | C     | E7 popup                                 | pass              | tests/experiments/E7-route-c-pages-workers.spec.ts | a popup is marked before its first script                                                 |
| page                  | C     | E7 same-origin-iframe                    | unavailable       | tests/experiments/E7-route-c-pages-workers.spec.ts | not exercisable on the frozen fixture                                                     |
| page                  | C     | E7 about-blank-child                     | unavailable       | tests/experiments/E7-route-c-pages-workers.spec.ts | not exercisable on the frozen fixture                                                     |
| page                  | C     | E7 sandboxed-frame                       | unavailable       | tests/experiments/E7-route-c-pages-workers.spec.ts | not exercisable on the frozen fixture                                                     |
| dedicated             | C     | E7 dedicated-worker                      | fail              | tests/experiments/E7-route-c-pages-workers.spec.ts | Route C refuses new Worker() rather than wrap it                                          |
| shared                | C     | E7 shared-worker                         | fail              | tests/experiments/E7-route-c-pages-workers.spec.ts | Route C refuses new SharedWorker() rather than wrap it                                    |
| shared                | C     | E7 shared-worker-identity                | fail              | tests/experiments/E7-route-c-pages-workers.spec.ts | a blob wrapper splits one shared worker into two                                          |

**Not mapped to a capability**

| Experiment | Verdicts | Pass | Fail | Unavailable | Reason                                                                            |
| ---------- | -------- | ---- | ---- | ----------- | --------------------------------------------------------------------------------- |
| E0         | 4        | 4    | 0    | 0           | extension loading methods; a precondition of every route                          |
| E1         | 30       | 24   | 6    | 0           | what chrome.debugger can do; a precondition of Routes A and B                     |
| E8         | 1        | 1    | 0    | 0           | d-other-clients: no other debugger client in the strict lab; a precondition of E8 |

stress: not recorded
<!-- decide:end -->

## What was observed

Each line cites its spec and hypothesis; counts are from this run's verdicts.

**Route A, `chrome.debugger`.**

- `tests/experiments/E2-route-a-register.spec.ts`, `service-worker-register`: fail, 100 of 100. With the tab armed before `register()`, every worker attached paused and took the bootstrap, but `caches` is `undefined` at that pause, so Cache Storage stayed unpatched (`patchSkipped` 100). `dedicated-worker`: the same, 10 of 10. `shared-worker`: fail, 10 of 10; a tab session never auto-attaches shared workers. `nested-worker`: unavailable, the frozen fixture starts none.
- `tests/experiments/E3-route-a-cold.spec.ts`, `before-script-execution`: pass, 120 of 120, late attaches 0, for service workers and dedicated workers. It needs the tab armed before the worker starts and an instrumentation breakpoint (`pauseBeforeScript`); at that pause `caches` exists. This is the only passing Route A path for a first start.
- `direct-attach-race`: fail, 1 of 120 (late attaches 119); attaching by id once `getTargets()` lists a worker loses to its first statement.
- `cold-start-navigation`: fail, 0 of 200 (late attaches 199). A worker restarted by a navigation is reported with `waitingForDebugger: false` (100) and the first request is unmarked. `pre-existing-running`: fail, 0 of 10; a running worker is reached late by construction. `wake-without-tab`: unavailable; no worker woke with no tab open (5 of 5 syncs fired at registration).
- `tests/experiments/E4-stop-restart.spec.ts`: `close-target` stops the worker in 29 of 29 and every trigger restarts it, but 25 of 29 restarts lost the first request to the bootstrap; `debugger-pause` holds a worker without stopping it (10 of 10); `terminate-execution` is refused (`Runtime.terminateExecution is not allowed for untrusted clients`, 3 of 3); `dnr-block-evict` and `unregister` leave the worker running and listed (10 of 10 each).

**Route B, `Fetch`.**

- `tests/experiments/E5-route-b-fetch.spec.ts`, `first`: fail, 100 of 100, but not at the transform: `transformed` 100 (every main script pauses on the worker session as `Other` and `Fetch.fulfillRequest` works). The wrapped worker's first request never reaches the fixture, `noEffect` 100, `TypeError: Failed to fetch`. Diagnostic `fulfilled-worker-address-space`: a fulfilled worker leaves from address space `Unknown` and Local Network Access blocks its requests to loopback with `InsecureLocalNetwork` (5 of 10 samples; the 5 controls pass). `offline`: fail, 10 of 10, `LocalNetworkAccessPermissionDenied`. Route B is blocked here for any worker whose app calls a loopback or private API, until a mitigation exists (an LNA grant, a policy, another route); that is an open owner decision.
- `imports`: pass, 40 of 40 (all 60 imports pause on the worker session). `update`: fail, 20 of 20: no `Fetch.requestPaused` for the update check, so the new version installs the unwrapped original (`notIntercepted` 20); Route B alone loses the wrapper at the first `update()`.
- `tests/experiments/E6-route-b-selection.spec.ts`: `c-workers` pass, 100 of 100 (dedicated and shared workers pick the new slot by synchronous XHR), `suspend` pass 6 of 6, `restart` pass 1 of 1. `a-switch` fail, 6 of 6 (`firstNotSelected` 4, `stalled` 2); `a-offline` fail, 5 of 5 (`stale`); `b-update` fail, 5 of 5 (`unprefixedAfter` 5).

**Route C, content scripts.**

- `tests/experiments/E7-route-c-pages-workers.spec.ts`, `page`: pass, 40 of 40; `cross-site-iframe`: pass, 10 of 10, only when the frame's origin is registered; `popup`: pass, 10 of 10. `same-origin-iframe`, `about-blank-child`, and `sandboxed-frame`: unavailable on the frozen fixture.
- `dedicated-worker` and `shared-worker`: fail, 60 of 60 each. Route C fails closed on workers: `fail-closed` throws `SecurityError` (20), `blob` changes `self.location` (20), `data` reports nothing (20); no wrapper keeps the worker's location and relative imports, and none ran unpatched (`unpatched` 0). `shared-worker-identity`: fail, 3 of 9 pairs: a blob wrapper splits one shared worker into two.

## Options for P2 to P6

The plan does not pick. Each option is a combination of routes per capability; the costs are consequences of the lines above, and the inferred ones are labelled.

- **Route A for service workers.** Reaches a first start (E3 `before-script-execution`) and stops a worker (`close-target`, E4), but cannot reach a restart before its first statement (E3 `cold-start-navigation` 0 of 200, E4 25 of 29 lost), nor a running worker. P2 would need every service-worker start to be preceded by an armed tab and a breakpoint, a way to refuse or hold a cold restart, and a position on the second DevTools client of the harness (inferred, not verified).
- **Route B for service workers.** Reaches imports, the slot switch of dedicated and shared workers, and restart (E5 `imports`, E6 `c-workers`, `restart`), but a fulfilled worker cannot reach loopback APIs (E5 `first`, `offline`), the update check is not interceptable (E5 `update`), and the slot selection for service workers failed (E6 `a-switch`, `a-offline`, `b-update`). P2 would need an LNA mitigation and a way to re-wrap after every update before it can claim a service worker.
- **Route C for pages.** Passes for pages, popups, and registered cross-site frames (E7), and fails closed for workers. P2 would handle pages here and need Route A or B (or a refusal) for every worker type; the frame kinds the fixture lacks stay untested.
- **Workers.** For dedicated and shared workers the passing evidence is Route B's slot switch by synchronous XHR (E6 `c-workers`, `suspend`) and Route A's breakpoint for dedicated workers (E3), with shared workers never reached by Route A (E2 `shared-worker`). Choosing none leaves them fail-closed under Route C.

## Not covered

- The stress runs of E3 and E6 (above), macOS and Windows, and a run without Playwright's CDP session.
- Push and Background Sync wake without a tab (`wake-without-tab`), nested workers, and same-origin, `about:blank`, and sandboxed frames: the frozen fixture cannot exercise them.
- E0 and E1, which feed no cell.
