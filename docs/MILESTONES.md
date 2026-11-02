# Milestones

Delivery follows the phases of [plan/PLAN.md](plan/PLAN.md). Each phase closes when its tasks pass and `vp run verify` exits 0 on the branch; progress is in [plan/CHECKLIST.md](plan/CHECKLIST.md). Checks that need a person (Chrome's dialog, the default profile on Windows and macOS, real agent sessions, publishing) never block a phase: they are listed in [plan/MANUAL_VALIDATION.md](plan/MANUAL_VALIDATION.md) and block only the release gate.

## Phases

| Phase | Goal                                                                                                               | Gate (automated)                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| F0    | Contracts and skeleton: ADRs, workspace layout, protocol schemas, capability matrix, fixture app, Chrome in Docker | `vp run verify`; ADRs committed; every requirement row of PLAN.md §1 points at a task                                |
| F1    | Connection and fidelity spike against Google Chrome in Docker, and the spike report                                | `vp run verify` with `test:browser`; spike report committed                                                          |
| F2    | First vertical flow without AI: record, assert, stop, restart the tool, reopen, replay, all from the localhost UI  | `tests/e2e/first-flow.spec.ts` and `vp run verify`                                                                   |
| F3    | Diagnostics and robust persistence: network, console, snapshots, storage, coverage, crash recovery, run comparison | `vp run verify`; `docs/CAPABILITIES.md` regenerated                                                                  |
| F4    | Editor, parameters, multiple profiles, export and import                                                           | `tests/e2e/export-import.spec.ts`: the A-B-A flow exported, imported with new bindings, replayed                     |
| F4A   | Locator lists, the function registry, and macros                                                                   | `tests/e2e/locators-functions.spec.ts`: function, locator fallback, loop with counter, export, import, replay        |
| F5    | Agents and the improvement cycle: MCP server, `agents setup`, skills, handoff, reproducers                         | `tests/contract/mcp.test.ts` scenario and `vp run verify`                                                            |
| F6    | Deep capture: IndexedDB, workers, Cache Storage, cookies, files                                                    | `vp run verify`                                                                                                      |
| F7    | Distribution and pilot: the `@recnrun/cli` package, lifecycle, documentation, release                              | `vp run verify` with `test:distribution`; release only after every manual item is recorded and publishing authorized |

Task lists, acceptance tests, and the manual items of each phase are in [PLAN.md §5](plan/PLAN.md#5-phases).

## History

- **M0: bootstrap, detection, and read-only explorer** (done, October 2026). The monorepo, its quality gates, and a first slice in which recnrun.com detected a Manifest V3 extension and listed the recordings it stored. Its end-to-end tests covered the install banner, the explorer, an origin guard on the `window.postMessage` bridge, the website's CSP, and a production manifest guard.
- **M1: workflow recording in the extension** (archived on 2026-11-02, never merged). Explicit start, stop, and resume per tab group from the extension. The work is kept at the tag `archive/workflow-recording-2026-11-02`.
- **Change of direction** (2026-11-02). A local service connected to the installed Chrome over CDP replaces the extension as the owner of the data ([ADR 0001](adr/0001-local-service-over-cdp.md)). F0.1 deleted the extension and the bridge ([ADR 0002](adr/0002-retire-extension-and-bridge.md)); recnrun.com became the landing and install guide. Of M0's acceptance, the CSP check survives in `tests/e2e/landing.spec.ts`.
