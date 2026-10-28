# POC checklist: sequential Incognito sessions

Plan: [poc-incognito-sessions-plan.md](poc-incognito-sessions-plan.md). Assignment: [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md). Report: `docs/POC-ORIGIN-SNAPSHOT.md`.

| Item                 | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Worktree             | `/Users/dannyelcf/src/recnrun-incognito-sessions-poc`            |
| Branch               | `poc/incognito-sessions`                                         |
| Planned base         | `44c154da29860c7a8df829e902b177df5ce2ba2a` (2026-10-28)          |
| Actual base (P0.1)   | `44c154d` (re-resolved 2026-10-28, unchanged)                    |
| Last recorded commit | `f53791c`                                                        |
| Decisions OD-1…OD-4  | defaults of plan §3, accepted by the user ("Avance", 2026-10-28) |

## Status legend

`[ ]` not started · `[i]` implemented and committed, awaiting the stage's `vp run verify` · `[x]` verified by the orchestrator · `[!]` blocked (reason on the line) · `[~]` partly done (what is missing on the line) · `[manual]` needs the user

## Resume protocol

1. `cd /Users/dannyelcf/src/recnrun-incognito-sessions-poc`; `git status` must be clean.
2. `git log --oneline -5`: the newest commit must be **Last recorded commit** above, or a checklist-only commit (`Record … in the POC checklist`) directly on top of it. Otherwise stop and reconcile before changing anything.
3. Read the plan section of the first task that is not `[x]`, and its evidence lines here.
4. Check the stop gates: do not start a task after an unpassed gate (G1, G2) without the user's go-ahead recorded under that gate.
5. After each task commit: add `red:`, `green:`, `commit:` lines under it, mark `[i]`, update **Last recorded commit**, and commit the checklist alone (`Record <task> evidence in the POC checklist`), since a commit cannot hold its own SHA.
6. At the end of a stage: run `vp run verify`, record the run id under the stage, mark the stage's tasks `[x]`.

Evidence format under each task:

```text
  red:    <command> → <quoted failure>
  green:  <command> → <result>
  commit: <sha> <subject>
  notes:  <exercised / not exercised and why>
```

## Stage 0 — Setup and reconnaissance

- [x] P0.1 Baseline: `vp install`, re-resolve `origin/master`, versions, baseline `vp run verify`, report skeleton
      red: n/a (docs only)
      green: `vp run verify` → run 1 exit 1 (pre-existing focus flake in `incognito.spec.ts`, then 25/25 with `--repeat-each=5`); run 2 exit 0 (`.artifacts/docker/2026-10-28T12-02-21.796Z-1433f9f5-2cce-4bf5-9a53-3c1e49edf6f6`)
      commit: 19d7088 Record the POC baseline and platform facts in its report
      notes: report sections 2 and 4
- [x] P0.2 Platform facts in a scratch copy (structured clone, runtime content script, DNR in Incognito, cookie stores)
      red: n/a (throwaway probe, nothing committed)
      green: scratch `vp run test:e2e -- tests/e2e/zz-probe.spec.ts` → 1 passed; facts in report §4
      commit: 19d7088 (with P0.1)
- [x] P0.3 Fixture server (`/sentinel`, `/inspect`, `/sw.js`, logs) + second `webServer` + `POC_REPEATS` forwarding
      red: `vp run test:e2e -- tests/e2e/poc-fixture.spec.ts` → `page.goto: net::ERR_CONNECTION_REFUSED at http://app.localhost:5191/sentinel?tag=normal-1…` (no fixture server; `.artifacts/docker/2026-10-28T12-05-56.444Z-acc5603c-fe1f-4809-aae5-795517fc417a`)
      green: same command → 1 passed: JS and HttpOnly cookies, localStorage, sessionStorage, IndexedDB record, cache entry all `normal-1`, one SW at `http://app.localhost:5191/`; `other.localhost` sees none; log has the `/sentinel` request and two reports (`.artifacts/docker/2026-10-28T12-07-32.869Z-5051aa75-8829-48e2-84aa-009b83fd008d`)
      commit: 672a37b Serve fixture origins for the Incognito sessions POC
      notes: curl smoke test of every route on the host (Node 22 type stripping); `POC_REPEATS=7` reaches `docker create --env` (stub `docker` on PATH); `vp check`, `vp run deps`, `dead-code` (Knip reads the webServer command, no `knip.jsonc` change), `duplication` (0 clones), `test:container` (13 pass) all pass

Stage 0 verify: first run exit 1 — P0.3's server took port 5191, which `dashboard-embedding.spec.ts` uses (`EADDRINUSE`); fixed in `369ab7a` (fixture server on 5192). Second run exit 0, 22/22 tasks, 151 unit/component, 43/43 e2e (`.artifacts/docker/2026-10-28T12-10-32.366Z-8b259847-a7cc-455e-82bf-7e2b54d0513d`).

## Stage 1 — Native context reset

- [x] S1.1 Domain: `ManagedWindowState`, `classifyIncognitoWindows`, `isAllowedTarget`
      red: `vp run test:unit` → 5 failed in `packages/domain/tests/managed-window.test.ts` against stubs (`v.any()` schema, empty classification, every target allowed), e.g. `chrome://settings/: expected true to be false`
      green: same command → 25 files, 95 tests passed
      commit: 17a4a1b Add the managed Incognito window state and its inventory rules
      notes: `vp check`, `vp run deps`, `vp run dead-code` pass; Incognito windows of an unreported `type` count as foreign (conservative), DevTools and `alwaysOnTop` windows are left out
- [x] S1.2 Background: `inventory`, `closeWindows` (waits for removal), `createNeutralWindow` (refuses when any Incognito window exists), state repository
      red: `vp run test:unit` → 16 failed against stubs that store nothing, list every window, remove without waiting, and create without checking, e.g. `createNeutralWindow > refuses while any Incognito window is open: promise resolved "{ generation: +0, windowId: 2, …(2) }" instead of rejecting` and `closeWindows > waits for Chrome to report each removal: expected true to be false`; `background-start` tracker test failed (`Matcher did not succeed in time`) before `startBackground` registered it
      green: same command → 27 files, 115 tests passed
      commit: 94e80cb Add Incognito window primitives and the managed window repository
      notes: `vp check`, `vp run deps`, `vp run dead-code` pass; `fakeBrowser.windows.create` opens no tab, so `tests/fake-windows.ts` adds one; the tracker also marks the window closed on `runtime.onStartup` (Chrome reuses window ids after a restart); not exercised in a real browser (S1.6)
- [x] S1.3 Workspace commands, `OWN_PAGE` routes, single-operation lock, stale `windowIds` refusal
      red: `vp run test:unit` → 9 failed in `apps/extension/tests/workspace-routes.test.ts` against stub commands with no lock, target rule, or foreign-set check, e.g. `refuses a second operation while one runs: expected { access: true, foreign: [], …(1) } to match object { busy: true }`, `refuses when the windows changed …: expected { ok: true, result: undefined } to deeply equal { ok: false, …(1) }`, `refuses browser-internal and unparsable targets …: expected { ok: true, result: undefined } to deeply equal { ok: false, …(1) }`
      green: same command → 28 files, 126 tests passed
      commit: b4ffcfe Add Incognito workspace commands behind a single operation lock
      notes: `vp check`, `vp run deps`, `dead-code`, `duplication` (0 clones), `test:extension-manifest` (6 pass, no permission added), `test:coverage` (per-file floor met; `commands.ts` 100/92.85/100/100, `windows.ts` 100/100/95.45/100) pass; `incognito.spec.ts` 5 passed; throwaway Docker probe (deleted) drove the real commands from `dashboard.html`: internal URL refused, foreign window blocks Start, stale `windowIds` refused, close-and-start closed the foreign window and opened the managed one on the target in 68 ms while a concurrent Start got busy, user closing the managed window → `closed`, next Start → generation 2; `extension.md` rule change loaded by Codex (`codex exec --ephemeral -s read-only`). Start also requires "Allow in Incognito"; an open managed window blocks both commands (closing it is left to the switch operations)
- [x] S1.3a Incognito `alwaysOnTop` windows block (orchestrator decision): only DevTools windows stay out of the inventory
      red: `vp run test:unit` → `classifyIncognitoWindows > counts an Incognito always-on-top window, such as a Document PiP, as foreign: expected { managed: undefined, foreign: [] } to deeply equal { managed: undefined, …(1) }`
      green: same command → 28 files, 127 tests passed
      commit: 2b5124c Count Incognito always-on-top windows as blocking the workspace
      notes: `vp check`, `vp run deps` pass; `workspace-windows.test.ts` inventory case now keeps the Incognito PiP; ARCHITECTURE's workspace paragraph states the rule
- [x] S1.3b `workspace-restart { url }` (orchestrator decision): close the managed window, open a fresh one, navigate; refusals for access, busy, internal URL, foreign windows, no active managed window
      red: `vp run test:unit` → 6 failed in `apps/extension/tests/workspace-restart.test.ts` against a stub `restart` that does nothing, e.g. `closes the managed window, then opens a fresh one, then navigates its tab: expected [] to deeply equal [ 1 ]`, `refuses while another Incognito window is open, and closes nothing: expected { ok: true, result: undefined } to deeply equal { ok: false, …(1) }`, busy case `expected "update" to be called at least once`
      green: same command → 29 files, 134 tests passed
      commit: 038dfb4 Add a workspace command that replaces the open managed window
      notes: `vp check`, `vp run deps`, `dead-code`, `duplication` (0 clones) pass; shared route-test helpers moved to `tests/workspace-harness.ts`; ARCHITECTURE workspace paragraph documents the command and that it discards the window's Incognito data until Stage 3; not exercised in a real browser here (the dashboard's Close and start empty in S1.4 drives it end to end)
- [x] S1.4 Dashboard: access requirement, blockers + "Close these windows and start", Start, "Use this tab's address"
      red: `vp run test:components` → 13 failed in `apps/extension/tests/incognito-workspace.browser.test.tsx` against a stub `IncognitoWorkspace` that rendered nothing, e.g. `expected undefined to be 'Incognito workspace'` and `expected '' to contain '2 Incognito windows are open'`
      green: same command → 8 files, 68 tests passed; `vp run test:unit` → 29 files, 135 tests; `vp run test:e2e -- tests/e2e/incognito-workspace.spec.ts tests/e2e/incognito.spec.ts tests/e2e/incognito-access.spec.ts` → 14 passed
      commit: 7386ad9 Add the Incognito workspace panel to the dashboard
      notes: panel replaces "New incognito window" (`IncognitoAccess.openWindow` became `watchWindows`); screenshots in `.artifacts/screens/S1.4/` (no-access, start, blocked, open, refused, address) viewed; `vp check`, `vp run deps`, `dead-code`, `duplication` pass; ARCHITECTURE, PRODUCT_BRIEF, MILESTONES updated as POC-branch behaviour. Pre-existing gap: `workspace-close-and-start` with an active managed window closes the foreign windows and then refuses, so the panel offers only "Close and start empty" in that state
- [x] S1.5 Record only the managed tab; existing e2e and product docs updated
      red: `vp run test:e2e -- tests/e2e/incognito.spec.ts -g "only the Incognito workspace"` → `toHaveCount` on the normal tab's Record: `Expected: 0, Received: 1`; `vp run test:unit` → 3 failed (`startSession` on an unmanaged tab: `promise resolved "undefined" instead of rejecting`; restart and close-and-start with a session: `expected { ok: true, result: undefined } to deeply equal { ok: false, …(1) }`); `vp run test:components` → 4 failed in `tab-list.browser.test.tsx`, `expected [ 'Record' ] to deeply equal []`
      green: `vp run test:unit` → 29 files, 138 tests; `vp run test:components` → 71 tests (after 496dd10); `vp run test:e2e --` incognito, session-control, incognito-access, orphaned-tab, incognito-workspace specs → 26 passed; `incognito.spec.ts --repeat-each=5` → 25 passed; full `vp run test:e2e` → 50 passed; `vp run test:coverage` → exit 0 (all files 99.31% statements, 97.55% branches)
      commit: 72e98a4 Record only the managed Incognito tab; 496dd10 Cover the dashboard control paths the shared ask helper left bare (control.ts fell under the per-file floor after S1.4 moved `ask`; validated by negative controls in a scratch worktree)
      notes: OD-2 refusal ("Stop the recording first.") on `workspace-close-and-start` and `workspace-restart`; `workspace-start` is not refused. E2E `activeTabId` now reads the focused window's active tab. New issue, not fixed: with two windows Chrome briefly reports both `focused` when focus moves to the Incognito window, so `toBrowserTabs` (first focused window) shows the old normal tab and no later event corrects it; the PiP test step that refocuses the managed tab from a second normal window was dropped (probe evidence in the report). Screenshot `.artifacts/screens/S1.5/record-managed-only.png` viewed
- [x] S1.5a Close-and-start refuses before closing anything while the managed window is open; the panel offers no command in the managed + foreign state (orchestrator decision)
      red: `vp run test:unit` → `workspace-close-and-start > refuses while the managed window is open, and closes none`: received `removed: [2]` and `"Close every Incognito window before RECnRun opens its own."` (it closed the shown window, then `startAt` refused); `vp run test:components` → `expected 'Incognito workspace…' to contain 'Close the other Incognito windows yourself'` (panel offered Close and start empty)
      green: `vp run test:unit` → 29 files, 139 tests; `vp run test:components` → 72 tests; `vp run test:e2e -- tests/e2e/incognito-workspace.spec.ts` → 8 passed (`.artifacts/docker/2026-10-28T13-17-33.228Z-1c5bc2b2-0ee8-4a35-a7fa-8e960afd0528`)
      commit: 675b6a3 Refuse close-and-start up front while the workspace is open
      notes: new `WorkspaceOpen` error ("Close and start empty replaces the open workspace; close the other Incognito windows first."); new e2e step opens a foreign window beside the workspace, sees no button and the hint, closes it as the user, and Close and start empty returns; screenshot `.artifacts/screens/S1.5a/open-and-foreign.png` viewed; ARCHITECTURE and PRODUCT_BRIEF updated; `vp check`, `vp run deps` pass
- [x] S1.5b PiP current tab across windows: prefer the focused window `windows.getLastFocused` names; restore the PiP e2e refocus step (orchestrator decision, OD-2 makes recording cross-window)
      red: `vp run test:e2e -- tests/e2e/incognito.spec.ts -g "drops closed tabs" --repeat-each=2` → 2 failed: Current tab `Expected substring: "http://app.localhost:5192/inspect?run=recorded"`, `Received string: "Current tabPrivacy policy · RECnRunhttp://localhost:5190/privacy/?other"` (`.artifacts/docker/2026-10-28T13-19-17.822Z-c417c884-8d2d-47d3-8d62-f76fbb3a4014`); `vp run test:unit` → 2 failed in `tabs.test.ts` against a stub that ignored the last focused id, `expected 1 to be 2`
      green: same e2e command → 2 passed (`.artifacts/docker/2026-10-28T13-23-30.136Z-8579479a-5c8c-4978-bfdf-d98586fda9b2`); `vp run test:unit` → 141 passed; `vp run test:e2e -- tests/e2e/incognito.spec.ts --repeat-each=10` → 50 passed (`.artifacts/docker/2026-10-28T13-23-40.024Z-5185afd2-fdc1-455e-aa61-48251ffae6d0`)
      commit: b84af8d Take the last focused window when Chrome reports two focused
      notes: probe (throwaway listener in the service worker): in `onFocusChanged` for the Incognito window, `getAll` reported the normal and the Incognito window both `focused` in 2 of 3 runs, `getLastFocused` named the Incognito one each time, `onActivated` did not fire, and a later `getAll` showed only the Incognito window focused; the PiP had read during the double report and no further event came. Does not explain the baseline flake (P0.1: "No tab in focus." on the PiP's first read, i.e. no browsing window focused at all, not two). Screenshot `.artifacts/screens/S1.5b/pip-recorded-current.png` viewed; ARCHITECTURE "Current tab" updated; `vp check`, `vp run deps` pass
- [x] S1.6 E2E reset experiment (six sentinel kinds, normal profile unchanged, repository readable) + negative control (foreign window keeps data, dashboard blocks)
      red: scratch worktree (`git worktree` under the scratchpad, deleted) where `workspace-restart` opens the new window before closing the old one (inventory check bypassed): `vp run test:e2e -- tests/e2e/poc-native-reset.spec.ts -g "Close and start empty"` → `toEqual(NOTHING)` failed, received `sentinel_js` and server-side `sentinel_http` cookies, localStorage, IndexedDB record, cache entry all `incog-1`, registration `http://app.localhost:5192/`, controller `…/sw.js` (scratch run `2026-10-28T13-29-57.578Z-bbf3e90d-f87a-4f22-9d8d-6550b81d7156`)
      green: `vp run test:e2e -- tests/e2e/poc-native-reset.spec.ts tests/e2e/poc-fixture.spec.ts` → 3 passed (`.artifacts/docker/2026-10-28T13-30-15.689Z-7c9528bc-93b7-4adc-b728-341880cac7a6`); observations kept as `reset-inspected.json` / `control-inspected.json` in each test's results
      commit: 33264a6 Prove the native reset of the Incognito workspace end to end
      notes: reset through the dashboard's Close and start empty to `/inspect`: every kind empty (sessionStorage is per tab, so its absence proves nothing), `/__log` report has empty `serverCookies`, generation +1; normal tab still `normal` everywhere; both seeded recordings listed. Control: foreign `about:blank` Incognito window → panel lists it, zero buttons (screenshot `.artifacts/screens/S1.6/blocked.png` viewed); service worker closes only the managed window, a new Incognito window's `/inspect` reads `incog-1` in every kind but sessionStorage, and the page is controlled by `sw.js`; the panel then lists 2 windows and no Start. Shared helpers moved to `tests/e2e/fixtures/sentinels.ts`; `vp check`, `deps`, `dead-code`, `duplication` (0 clones) pass
- [x] S1.7 Stress loop (`POC_REPEATS=50`), teardown signal if survivors, report section
      red: no committed cycle leaked, so there is no product red and `closeWindows` waits on no new signal; the loop's assertion is the S1.6 one, whose scratch negative control (new window before the old one closed) fails it with every kind holding `incog-1`
      green: `POC_REPEATS=50 vp run test:e2e -- tests/e2e/poc-native-reset.spec.ts` → 2 passed, 50 of 50 cycles empty (`.artifacts/docker/2026-10-28T13-36-22.690Z-cd60cc21-5853-4c9b-a4b8-0d80a9fa6808`, stats in the test's `teardown.json`); also with `cookies` added in a scratch build only → 2 passed, 50 of 50 empty (scratch run `2026-10-28T13-34-54.652Z-a5aba681-6986-4f7f-a33f-0fda09d2458e`)
      commit: f53791c Stress the native reset and time its teardown signals
      notes: Playwright 1.64.1 image, bundled Chromium 156.0.8078.4. Committed build (ms, min/median/p95/max): `windows.remove` call→`onRemoved` 4.3/4.7/5.7/6.1; call→first `getAll` without an Incognito window 12.7/13.9/16.1/16.6; `onRemoved`→next `windows.create` 10.4/11.6/12.7/14; create→`onCreated` 13.9/14.6/15.6/17; order in all 50: remove call < onRemoved < no window < create call < created. Scratch build with `cookies`: call→store count drops 14.5/15.8/20.3/20.5, store gone→create call 0.4/0.6/0.8/1.4, order remove call < onRemoved < no window < store gone < create call < created in all 50; the product does not wait on the store, so that margin is only what the run saw. The store count needs `cookies`, which arrives in S2.2. Probe in `tests/e2e/fixtures/teardown-probe.ts`; `vp check`, `deps`, `dead-code`, `duplication` (0 clones) pass

Stage 1 verify: exit 0 on `1216339`, 220 unit/component, 53/53 e2e, coverage 99.32% statements / 97.6% branches (`.artifacts/docker/2026-10-28T13-40-19.702Z-9d6e4aa9-d8a8-4096-97a4-2032ccf009d8`).

### Gate G1 — native reset

- [x] Report section and verdict written: native reset **GO** (report §5); carried risk: S2.5 waits until no Incognito cookie store is listed before creating the window
- [ ] User go-ahead for Stage 2: _pending_

## Stage 2 — Restore before application bootstrap

- [ ] S2.1 Conventional fixture app `/app/` + plain Incognito baseline
- [ ] S2.2 Test/dev permissions (`declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, fixture hosts) + test-manifest guard; production unchanged
- [ ] S2.3 Barrier module (append CSP, block subresources, bound redirects, register agent; verified removal)
- [ ] S2.4 Origin agent (validated port, structured clone, transaction completion) + dependency rule + ARCHITECTURE
- [ ] S2.5 Bootstrap sequence (cookie store from tab, cookies by `storeId`, barrier, restore, remove, reload same tab); before creating the window, wait until `getAllCookieStores()` lists no Incognito store (G1 carried risk)
- [ ] S2.6 E2E barrier proof at 0 ms and 2,000 ms (`POC_REPEATS=50`), site CSP kept, network bounded; scratch negative control
- [ ] S2.7 Operation journal + failure paths (restore failure, tab closed, extension reload) with cleanup

Stage 2 verify: _pending_

### Gate G2 — startup barrier

- [ ] Report section and verdict written
- [ ] User go-ahead for Stage 3: _pending_

## Stage 3 — Snapshot fidelity and consistency

- [ ] S3.1 Domain `IdentityCapture` v1
- [ ] S3.2 Capture repository in extension IndexedDB with atomic publish (+ `unlimitedStorage`)
- [ ] S3.3 IndexedDB adapter, full schema and keys, `autoIncrement` case
- [ ] S3.4 Transport fidelity round trip (+ scratch negative control without `message_serialization`)
- [ ] S3.5 localStorage and sessionStorage adapters
- [ ] S3.6 Cookies adapter (all attributes, prefixes, partitioned)
- [ ] S3.7 Cache Storage adapter with `unsupported` classification
- [ ] S3.8 Full lifecycle coordinator (switch, suspend, resume, new, delete; commit before close; stale drops)
- [ ] S3.9 Dashboard identities, persistence note, delete, conflicts, failures
- [ ] S3.10 Writers during capture (page, worker, Service Worker) and the consistency boundary
- [ ] S3.11 Lifecycle E2E suite (A→B→A→C→A ×10, failures, restarts, stale messages, concurrency, 10,000 records)

Stage 3 verify: _pending_

### Gate G3 — data fidelity and capture consistency

- [ ] Report section and verdicts written (stop only on NO-GO)

## Stage 4 — PWA compatibility and Zephyr

- [ ] S4.1 PWA fixture `/pwa/` + native Incognito baseline
- [ ] S4.2 PWA through A→B→A→C→A (first load, controlled reload, version change, offline cases)
- [ ] S4.3 Declared capability: additional cookie hosts (fixture SSO)
- [ ] [manual] S4.4 Zephyr build, `vp run poc:zephyr`, runbook; user runs baseline and A→B→A→C→A
- [ ] S4.5 Zephyr results and verdict ("not validated" without the user's run)

Stage 4 verify: _pending_

## Stage 5 — Delivery

- [ ] D.1 Timings aggregated (capture, transport, persistence, teardown, bootstrap, restore, PWA readiness, total; 10,000-record size)
- [ ] D.2 Durable docs (ARCHITECTURE, PRODUCT_BRIEF, POCS, TROUBLESHOOTING)
- [ ] D.3 Report complete with six verdicts and recommendation
- [ ] D.4 `vp run verify` exit 0: _run id pending_

## Optional

- [ ] C.1 Reused Incognito context comparison (only with the user's go-ahead after G3)

## Parallel-safe pairs

- P0.2 and P0.3 (P0.2 works in a scratch copy).
- S1.1 and the fixture pages of S2.1 do not touch the same files, but S2.1 waits for Gate G1 by rule.
- S3.5, S3.6, S3.7 after S3.4, if each implementer works in its own worktree and the orchestrator merges in order.

## Gate decisions log

| Date | Gate | Verdict | User decision |
| ---- | ---- | ------- | ------------- |
