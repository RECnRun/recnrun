# RECnRun — POC plan: sequential Incognito sessions (origin snapshots)

- Assignment (verbatim, the source of every requirement): [poc-incognito-sessions-assignment.md](poc-incognito-sessions-assignment.md)
- Checklist (progress, evidence, resume protocol): [poc-incognito-sessions-checklist.md](poc-incognito-sessions-checklist.md)
- Report (deliverable, written as the stages run): `docs/POC-ORIGIN-SNAPSHOT.md`, created by task P0.1

## 1. Objective

Find out, with the real extension, whether RECnRun can keep exactly one identity active in a managed Incognito window and switch identities by **save → close the whole Incognito context → create a fresh one → restore the destination before the app starts**, using the browser's native storage (no per-tab virtualization, Service Workers left on). The POC ends with a separate GO / CONDITIONAL GO / NO-GO for: native reset, data fidelity, startup barrier, capture consistency, local PWA compatibility, and Zephyr. Evidence that a property is infeasible is a valid result.

Not in scope: a recorder or runner, a polished UI, incremental backup, companion apps, `chrome.debugger` or CDP in the product, patching page APIs, building every adapter after an essential gate fails.

## 2. Workspace

| Item           | Value                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Worktree       | `/Users/dannyelcf/src/recnrun-incognito-sessions-poc`                                                  |
| Branch         | `poc/incognito-sessions` (no upstream; never push without the user's authorization, never to `master`) |
| Base           | `origin/master` = `44c154da29860c7a8df829e902b177df5ce2ba2a`, resolved 2026-10-28; P0.1 re-resolves it |
| Plan files     | this file, the checklist, the assignment                                                               |
| Report         | `docs/POC-ORIGIN-SNAPSHOT.md`                                                                          |
| Local captures | real-app captures (Zephyr) only under `.artifacts/`, never committed, deleted after the run            |

Read before writing code: `AGENTS.md`, `.claude/rules/{extension,domain,tests}.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT_BRIEF.md`, `docs/POCS.md`.

## 3. Decisions to confirm (defaults apply until the user changes them)

| ID   | Question                                                                   | Default in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-1 | Do new permissions reach the production manifest?                          | No. The production manifest and the existing guard stay as they are. `development` and `test` builds add each permission in the task that first needs it, with host access limited to the fixture origins (and, for the manual Zephyr build only, hosts passed through `RECNRUN_POC_HOSTS`). `manifest.checks.mjs` gains a test-build assertion listing the exact POC set. The production dashboard shows the workspace as unavailable in that build. |
| OD-2 | What happens to a recording session (`RecordingSession`) during a switch?  | Record is offered only on the managed tab. Switch, Suspend, and Resume are refused while a recording session exists ("Stop the recording first"). Following a recording across identities is a later product decision.                                                                                                                                                                                                                                |
| OD-3 | Where the POC stops for the user                                           | Hard stop after Gate G1 (native reset) and Gate G2 (startup barrier): report and wait for a go-ahead. Gate G3 (fidelity) is reported but does not stop unless its verdict is NO-GO.                                                                                                                                                                                                                                                                   |
| OD-4 | Zephyr needs Keycloak cookies on `login-acc.one.be` and opens a second tab | Treated as declared capabilities: "additional cookie hosts" is built in S4.3 with a fixture SSO host. A second application tab stays out of scope (it raises a conflict); extending to it needs a new decision.                                                                                                                                                                                                                                       |

## 4. Prior work consulted (nothing copied)

Read for context only, with `git show <branch>:<path>`; no commit or code from these branches enters this one.

- **PR #17, `poc/origin-snapshot`** (`docs/poc-origin-snapshot-results.md`). Findings that shape this plan:
  - Chromium 156 (Playwright 1.64.1, Docker image `mcr.microsoft.com/playwright:v1.64.1-noble`) supports `"message_serialization": "structured_clone"` (Chrome 148+); about 10 MB went through one message. To re-verify in P0.2 with this repo's WXT output.
  - A DNR rule appending a CSP to the document was **rejected there** because the app's Service Worker served the document and the header was not applied. In a fresh Incognito context no worker exists at bootstrap, which is exactly the hypothesis Stage 2 must prove, not assume.
  - `deleteDatabase` cannot be cancelled; a live worker can hold IndexedDB connections. A fresh context removes both problems for the restore side; capture still runs against a live app (Stage 3 consistency).
  - Zephyr: Angular + `ngsw`, `navigationUrls` exclude segments with `__` or a dot, Keycloak sign-in on `login-acc.one.be` (tokens in memory, silent SSO through that host's cookies), Agenda opens a second tab.
  - On macOS, "Allow in Incognito" lives in Secure Preferences and a pre-written profile file does not take; the repo's `incognitoAccess` fixture works on Linux (Docker). Host-side manual runs need the user to flip the toggle (never the extension).
- **PR #14** (tab-group containers) and **PR #15** (single-tab prelude): the namespace/prelude designs this POC deliberately does not use.
- **SplitSession** `475afe8`: reuse only test ideas (adversarial cases, navigation ordering, cookie attributes). No container engine, no worker policy.

## 5. Vocabulary and naming

The domain already uses **Workspace** (the origin a recording starts on, `src/dashboard/workspace.ts`) and **Snapshot** (the stored recordings document). New identifiers must not reuse them:

| Prose (UI and docs)      | Code                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| Incognito workspace      | `ManagedWindow` (one window, one app tab, a `generation` number)      |
| Identity / saved session | `Identity` (id, label, target URL, declared capabilities)             |
| Origin snapshot          | `IdentityCapture`, schema `IdentityCaptureSchema`, own version number |
| Lifecycle operation      | `WorkspaceOperation` (`start`, `switch`, `suspend`, `resume`, …)      |
| Bootstrap barrier        | `barrier` (DNR rules + runtime content script for one tab)            |
| Page-origin agent        | `src/origin/*`, the runtime-registered content script                 |

## 6. Target design (to be proven stage by stage)

### Components

| Where                                       | Role                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`                           | `ManagedWindowState`, `Identity`, `IdentityCapture` (versioned, distinct from `Snapshot`), `WorkspaceOperation` journal schemas; pure rules (window inventory classification, URL target rules, state machine) |
| `apps/extension/src/background/workspace/*` | The coordinator in the normal service worker: inventory, close, create, cookie store resolution, cookies adapter, barrier, operation lock, journal recovery, timings                                           |
| `apps/extension/src/storage/*`              | Repositories: managed window state and journal (WXT `storage`), identities and captures (extension IndexedDB, atomic publish)                                                                                  |
| `apps/extension/src/origin/*`               | Page-origin agent (isolated world, registered only during bootstrap/capture): reads and writes the origin's IndexedDB, Web Storage, Cache Storage; talks only to the background over a validated port          |
| `apps/extension/src/messaging/*`            | `workspace-protocol.ts` (dashboard → background commands, `ownPage` only), `origin-protocol.ts` (agent ↔ background, validated by tab, `documentId`, origin, operation id, generation)                         |
| `apps/extension/src/dashboard/*`            | Incognito workspace panel: access requirement, blockers with "Close these windows and start", identities, Switch / Suspend / Resume / New / Delete, conflicts, failures, "saved on this computer" note         |

New dependency-cruiser rule: `src/origin` imports no `storage`, `background`, `dashboard`, `session`, `views`, `content`, nor `wxt/utils/storage`, and lint forbids `browser.storage` there, as for `src/content`. The website bridge never carries a capture.

### Switch lifecycle (assignment, Stage 3)

`validate → recheck inventory → capture (agent + cookies) → commit capture (atomic) → recheck inventory → close managed window → observe removal → verify inventory empty and reset boundary → create neutral window (about:blank) → resolve its cookie store from the tab → restore cookies with that storeId → install barrier → navigate to target → agent restores, waits for transaction completion → remove barrier → reload same tab → verify readiness → mark destination active`.

Suspend = the first seven steps. Resume = from "create neutral window" with an existing **complete** capture. New identity = from "create neutral window" with nothing restored. Every step has a timeout, writes its name to the journal, and records its duration (no payload) for the timing report.

### Guards that every operation keeps

- One operation at a time (in-memory lock plus persisted journal `local:workspace-operation`). A journal found unfinished at service-worker start becomes `failed (interrupted at <step>)`, and its barrier rules and registered scripts are removed. Nothing unfinished ever reads as success.
- Every message from the agent carries operation id and generation; the background drops any that do not match the current ones (stale documents, old generations).
- Never create a window while any Incognito window exists. Never close a window the user was not shown. A window or tab appearing during a session becomes a visible conflict that blocks switching. Observing events cannot stop users or other extensions from opening windows: the docs say so.
- Never log cookie values, tokens, or capture payloads; diagnostics name counts, sizes, and step names only.

## 7. Permissions (added only in the task that demonstrates the need; OD-1)

| Permission                         | First needed | Why                                                                                          |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| none new                           | Stage 1      | `windows.*` needs no permission; `tabs` already exists                                       |
| `declarativeNetRequest` + hosts    | S2.2         | Tab-scoped session rules: append CSP, bound bootstrap network                                |
| `scripting`                        | S2.2         | `registerContentScripts` for the origin agent, only during an operation                      |
| `cookies`                          | S2.2         | Resolve the tab's cookie store; capture and restore cookies with an explicit `storeId`       |
| `webNavigation`                    | S2.2         | Commit and `documentId` of each bootstrap navigation                                         |
| `unlimitedStorage`                 | S3.2         | Captures in extension IndexedDB beyond the default quota (10,000-record test)                |
| host permissions                   | S2.2         | Test build: fixture origins only (`http://*.localhost/*`); Zephyr build: `RECNRUN_POC_HOSTS` |
| `message_serialization` (manifest) | S2.4         | Structured-clone transport of `Date`, `Blob`, `ArrayBuffer` between agent and background     |

## 8. Test infrastructure

- **Fixture origins.** A small Node server, `tests/e2e/apps/server.ts`, started as a second Playwright `webServer` on port 5191, serves `http://app.localhost:5191` (the application), `http://other.localhost:5191` (negative checks), and later `http://sso.localhost:5191` (S4.3). `*.localhost` resolves to loopback and is a secure context (Service Workers and Cache Storage work), and the RECnRun content script does not match it (its test matches are `localhost` and `127.0.0.1` only).
- **Fixture pages** (observation only; none waits for the extension):
  - `/sentinel?tag=` writes a tagged cookie (plus an HttpOnly one set by the server), localStorage, sessionStorage, IndexedDB record, Cache Storage entry, and registers `/sw.js`.
  - `/inspect` reads all six kinds plus `navigator.serviceWorker.getRegistrations()` and the controller, registers nothing, and reports to `window.__inspected` and the server log.
  - `/app/` the conventional app (S2.1): its first inline `<head>` script synchronously reads Web Storage and `document.cookie` and starts an IndexedDB open and read; then a module script, a dedicated worker, a same-origin subframe, an image and a fetch; a `/app/redirect` hop; an optional strict site CSP variant (`?csp=1`).
  - `/pwa/` (S4.1): manifest, Service Worker with `clients.claim`, worker-initiated authenticated `fetch('/api/me')`, worker IndexedDB and Cache Storage use, a version switch on the server.
  - Server log endpoints the spec queries (requests seen, beacons, per run id).
- **Test handles.** Test builds expose `recnrunPoc` on the service worker global (`src/background/test-handles.ts`, installed only when `import.meta.env.MODE === "test"`): restore delay, one-shot failure injection per step, timing read-out. The production bundle must not contain it (checked in `manifest.checks.mjs` or a build check). Negative controls that need product code removed run in a scratch worktree, never in final code.
- **Repeats.** Experiment specs read `POC_REPEATS` (default 3 so `vp run verify` stays reasonable; recorded experiment runs use the counts in each task). Commands: `POC_REPEATS=50 vp run test:e2e -- tests/e2e/poc-<name>.spec.ts`. Confirm `scripts/test-container.mjs` forwards the variable (P0.3), else add that forwarding.
- **Timings.** Specs attach the coordinator's step timings as JSON (`testInfo.attach`), so they land in `.artifacts/docker/<run-id>/`; D.1 aggregates them.
- **Profiles.** `tests/e2e/fixtures/extension.ts` gains an option to keep the profile directory so a spec can close and relaunch Chromium (browser restart, S3.11). Incognito access keeps using the existing pre-written profile (works on Linux/Docker).
- Window creation and closure in product paths always go through the extension. Playwright only observes, clicks the dashboard, simulates the user (opening a foreign Incognito window, closing a tab), and injects faults.

## 9. Stages and tasks

Each task is one commit with red/green evidence, done by `plan-implementer` (or the orchestrator), in order unless marked parallel. "Red" names the failing condition to observe first; "Green" the acceptance. Every task ends with `vp check` and `vp run deps`; every stage ends with `vp run verify` run by the orchestrator, who then marks the stage's tasks `[x]`.

### Stage 0 — Setup and reconnaissance

**P0.1 Baseline and report skeleton.** `vp install`; `git fetch` and record `origin/master` (if it moved past `44c154d`, stop and ask whether to rebase the branch). Record host OS, host Chrome version, Docker Chromium version (a throwaway spec printing `browser.version()`), Playwright and WXT versions. Run `vp run verify` once on the untouched base and record the run id. Create `docs/POC-ORIGIN-SNAPSHOT.md` with the sections of §10 and the environment table. Commit: docs only (`No-behavior-change:`).

**P0.2 Platform facts (throwaway, scratch worktree).** Build a scratch copy of the test extension and confirm on Docker Chromium, recording each in the report: WXT keeps `message_serialization` in the built manifest and `runtime.connect` ports carry `Date`/`Blob`/`ArrayBuffer` from a content script to the spanning worker; a WXT content-script entrypoint with `registration: "runtime"` is emitted and absent from `content_scripts`; `scripting.registerContentScripts` works for an Incognito tab of a spanning extension; DNR session rules with `tabIds` and `modifyHeaders` (append `Content-Security-Policy`) apply to an Incognito tab; `cookies.getAllCookieStores()` lists the Incognito store with the tab id and drops it after the last Incognito window closes. Nothing from the scratch copy is committed; the report gets the facts. Commit: report only.

**P0.3 Fixture server.** `tests/e2e/apps/server.ts` with `/sentinel`, `/inspect`, `/sw.js`, log endpoints; second `webServer` in `playwright.config.ts`; `POC_REPEATS` forwarded into Docker. Red: a spec `tests/e2e/poc-fixture.spec.ts` that writes sentinels in a normal tab and reads them back through `/inspect` fails (no server). Green: it passes, all six kinds reported.

### Stage 1 — Native context reset

**S1.1 Domain: managed window state and inventory rules.** `packages/domain/src/managed-window.ts`: `ManagedWindowStateSchema` (`generation`, `windowId`, `tabId`, `status`), pure `classifyIncognitoWindows(windows, managed)` → `{ managed, foreign }`, `isAllowedTarget(url)` (only `http:`/`https:`; rejects `chrome:`, `chrome-extension:`, `about:`, `devtools:`, `view-source:`, `data:`, `file:`, `blob:`). Red: unit tests fail against stubs. Green: pass.

**S1.2 Background: window lifecycle primitives.** `src/background/workspace/windows.ts`: `inventory()` (Incognito windows only, PiP `alwaysOnTop` windows excluded as the tab model does), `closeWindows(ids)` that resolves only after `windows.onRemoved` for each and a fresh inventory shows them gone, `createNeutralWindow()` that refuses when any Incognito window exists; `src/storage/managed-window-repository.ts` persists state and the generation. Unit tests with `fakeBrowser`. Red/green on the refusal and the removal wait.

**S1.3 Commands and the operation lock.** `messaging/workspace-protocol.ts` (`workspace-status`, `workspace-start { url }`, `workspace-close-and-start { url, windowIds }`), routes with `OWN_PAGE` only; one operation at a time (a second gets `{ ok: false, error: "busy" }`); `close-and-start` refuses when the current foreign set differs from `windowIds` (refreshed decision). Start = inventory empty → create neutral window → navigate the tab to the validated URL. Red: route tests for busy, stale `windowIds`, internal URLs. Green.

**S1.4 Dashboard: Incognito workspace panel, start path.** Without access: the existing banner and Start disabled with the requirement stated. With access and foreign windows: list them (count, title only in memory) with **Close these windows and start** and a hint to close them by hand; refresh on window events. With none: URL field, **Start**, and **Use this tab's address** on normal tabs (their cookies and storage are not copied: say so). Replace "New incognito window". Component tests in Browser Mode. Red/green.

**S1.5 Record only the managed tab.** Normal tabs and unmanaged Incognito tabs lose Record; `start-session` refuses any tab other than the managed one; Switch/Suspend/Resume refuse while recording (OD-2). Update `incognito.spec.ts` and `session-control.spec.ts` to record the managed tab, and the "RECnRun never closes an incognito window" statements in `PRODUCT_BRIEF.md`, `ARCHITECTURE.md`, `MILESTONES.md`. Red: an e2e assertion that a normal tab offers no Record fails on today's behavior. Green.

**S1.6 E2E: reset experiment and negative control.** `tests/e2e/poc-native-reset.spec.ts`: sentinels `normal-1` in a normal tab and `incog-1` in the managed window (all six kinds); seeded recordings in the extension repository; reset through the dashboard (start a new empty identity); in the new window, open `/inspect` from the neutral page before any app page: no `incog-1` data, no registration, no controller; normal tab still reads `normal-1`; the dashboard still lists the seeded recordings. Negative control: a foreign Incognito window opened as a user would (`windows.create` from the test, not the product); Playwright closes only the managed page; a new Incognito window still reads `incog-1`, and the dashboard shows the blocker and refuses Start. Red: before S1.2–S1.4 the spec fails at the dashboard step; the negative control must show surviving data (record it).

**S1.7 Stress and teardown signal.** In the same spec, a loop of `POC_REPEATS` immediate close/recreate cycles with a fresh tag per cycle, inspecting for any previous tag. Record per cycle: time from last `onRemoved` to creation, `getAllCookieStores()` before/after, any survivor. Run with `POC_REPEATS=50`. If a survivor appears, find the signal that the context is gone (candidate: the Incognito cookie store disappearing) and wait on it in `closeWindows`, never a fixed sleep; red is the failing loop, green the loop with the signal. Report: commands, counts, failures, browser version, the supported reset claim.

**Gate G1 — native reset verdict.** The orchestrator runs `vp run verify`, writes the Stage 1 section and the native reset verdict in the report, and stops for the user (OD-3). NO-GO ends expansion: deliver the report and the minimal code.

### Stage 2 — Restore before application bootstrap

**S2.1 Conventional fixture app and its baseline.** `/app/` as described in §8, logging every request (path, type, time) and the observer's first reads. Spec: plain Incognito start (no restore) — the observer reads empty values, every script runs, the worker and subframe load. Red: the spec fails before the page exists. Green.

**S2.2 Permissions and manifest guard for the barrier.** Test and development builds add `declarativeNetRequest`, `scripting`, `cookies`, `webNavigation`, and fixture host access; production unchanged (OD-1). `manifest.checks.mjs` gains a test-build check listing exactly this set and keeps the production check as is. Red: the new check fails before the manifest changes. Green. Docs: security model paragraph on the test-only permissions.

**S2.3 Barrier module.** `src/background/workspace/barrier.ts`: `install(tabId, targetOrigin, operation)` adds session rules scoped to `tabIds: [tabId]`: (a) `modifyHeaders` **append** `Content-Security-Policy: script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'` on `main_frame` and `sub_frame`; (b) block every other resource type for that tab; (c) block `main_frame` requests leaving the target origin (a redirect off-origin fails the operation explicitly). Registers the origin agent (`registerContentScripts`, `persistAcrossSessions: false`, `runAt: "document_start"`, matches the target origin). `remove()` deletes both and verifies with `getSessionRules`/`getRegisteredContentScripts`. Unit tests through a small `BarrierApi` port with a fake (fakeBrowser lacks DNR). Red/green.

**S2.4 Origin agent, minimal restore.** `src/origin/agent.ts` + runtime entrypoint: at `document_start`, open a port; the background validates `sender.tab.id`, `sender.documentId`, `sender.origin`, operation id, and generation, then sends the restore payload (structured clone, `message_serialization`); the agent restores localStorage, sessionStorage, and IndexedDB records (simple schema for now), resolves only after each transaction's `complete` and closing the databases, and replies `restored`. Dependency-cruiser rule and lint restriction for `src/origin`; `ARCHITECTURE.md` documents the new responsibility (site storage access) and that it never touches extension storage. Unit tests for the protocol schemas; Browser Mode tests for the restore functions. Red/green.

**S2.5 Bootstrap sequence.** Coordinator: create neutral window → resolve the cookie store whose `tabIds` include the managed tab (fail if none; never store `"0"` or a hard-coded id) → set cookies with that `storeId` → install barrier → `tabs.update(url)` → wait for the agent's `restored` (timeout) → remove barrier and verify → `tabs.reload` the same tab → wait for the new document's commit → release. Test handle: restore delay. Red: the e2e below fails without the sequence. Green.

**S2.6 E2E: barrier proof.** `tests/e2e/poc-barrier.spec.ts` with restore delay 0 ms and 2,000 ms, `POC_REPEATS` each (recorded run: 50 per delay): the observer's **first** reads in the released app document equal the restored values (cookie, localStorage, sessionStorage, IndexedDB); during the barrier the server saw only the allowed main-frame document requests (and the redirect hop), no module, worker, subframe, image, or fetch; no observer beacon before release; the `?csp=1` site CSP is still enforced after release (a violation the site's own policy forbids still fires); `navigator.serviceWorker.controller` is null at bootstrap; the normal cookie store is unchanged. Negative control in a scratch worktree: barrier disabled + 2,000 ms delay → the observer reads empty values (deterministic red). Record the numbers.

**S2.7 Failure paths and journal.** `src/storage/operation-journal.ts` (`local:workspace-operation`: id, kind, step, generation, started); service-worker start recovers an unfinished journal as `failed (interrupted at <step>)` and removes rules and scripts. E2E: injected restore failure, tab closed during bootstrap, extension reload during bootstrap → the dashboard shows the explicit failure, `getSessionRules()` and `getRegisteredContentScripts()` are empty, the app was never released (the observer never ran with partial data). Red/green per case.

**Gate G2 — startup barrier verdict.** `vp run verify`, report section, verdict, stop for the user. If the DNR candidate fails, the report names the failure and proposes at most two simpler supported alternatives for the user to choose; do not build a general interception layer.

### Stage 3 — Snapshot fidelity and consistency

**S3.1 Domain: `IdentityCapture` v1.** `packages/domain/src/identity-capture.ts`: identity id, target URL, origin set, declared capabilities, adapter list with per-adapter status, capture start/end times, `status` (`in-progress` | `complete` | `failed`), schema descriptors (databases, versions, stores, key paths, `autoIncrement`, indexes with `unique`/`multiEntry`), cookies with every attribute, Web Storage maps, cache entries, and an `unsupported` list with reasons. Values stay `unknown` with a declared-types list. Unit tests; never merged with `Snapshot`. Red/green.

**S3.2 Capture repository with atomic publish.** `src/storage/identity-captures.ts` over extension IndexedDB: parts written under a new capture id, then one transaction flips the identity's pointer to it and removes the previous; readers see only `complete` captures; delete identity removes all. `unlimitedStorage` (test/dev). Browser Mode tests (real IndexedDB): interrupted write leaves the previous capture readable. Red/green.

**S3.3 IndexedDB adapter, full.** Capture: `indexedDB.databases()`, one readonly transaction over all stores per database, schema plus `getAll`/`getAllKeys` (or cursor) per store, chunked per store. Restore in the fresh context: open at the captured version, create stores and indexes in `upgradeneeded`, put with explicit keys for out-of-line stores, confirm with `complete`. Cases: indexes, inline and out-of-line keys, composite keys, empty stores, extra databases, schema changes between identities, `autoIncrement` after deleting the highest generated key (report the observed next key; do not claim generator preservation). Browser Mode tests + e2e. Red/green.

**S3.4 Transport fidelity.** E2E round trip app → agent → background → extension IndexedDB → agent → app for `Date`, `Blob` with type, `ArrayBuffer`, typed arrays, `Map`, `Set`, nested objects, `null`/`undefined`, a multi-megabyte record; values compared by type and content. If `message_serialization` is missing at runtime, capture fails with a named error (red: build without the key in a scratch copy). Record the Chrome version and WXT output.

**S3.5 Web Storage adapters.** localStorage and sessionStorage (per tab: captured from the managed tab, restored in the new tab before the reload). Tests. Red/green.

**S3.6 Cookies adapter.** Background, by `storeId`: capture and restore host-only and domain cookies of the origin set, every attribute (`secure`, `httpOnly`, `sameSite`, `path`, expiry, session cookies, `partitionKey`), SplitSession-style cases (path shadowing, `__Host-`/`__Secure-` prefixes, `SameSite=None` without `Secure` rejected). Unit tests + e2e (HttpOnly cookie reaches the server on the first request). Red/green.

**S3.7 Cache Storage adapter.** Requests (URL, method, headers) and responses (status, status text, headers, body bytes); opaque responses and non-reconstructable entries go to `unsupported` with a reason, never silently. Browser Mode + e2e. Red/green.

**S3.8 Full lifecycle coordinator.** Switch, Suspend, Resume, New, Delete over §6; the capture commits before any close; capture or persistence failure keeps the workspace open and reports it; resume of a missing, invalid, or incomplete capture is an error, never a new session; stale agent messages dropped by generation and document. Pure state-machine unit tests plus coordinator tests with fakes. Red/green.

**S3.9 Dashboard: identities and conflicts.** Saved identities with label, last capture time and size, "Saved on this computer in RECnRun, kept after Incognito closes", **Delete**; Switch to, Suspend, Resume, New identity; active identity; conflict banner when an unexpected Incognito window or tab appears (switching disabled until resolved); failures with the step name. Component tests. Red/green.

**S3.10 Writers during capture and consistency boundary.** E2E with a page writer (interval), a dedicated worker writer, and a Service Worker writer, each active during capture and between commit and close. Assert each database's capture is internally consistent (one readonly transaction), no write of one identity appears in another, and writes after the cutoff are absent after resume (not claimed preserved). Write down the supported boundary (per-database consistency, no cross-adapter atomicity) and, if needed, a quiescence restriction with its test.

**S3.11 Lifecycle E2E suite.** `tests/e2e/poc-lifecycle.spec.ts`: A → B → A → C → A with distinct markers (recorded run: 10 repetitions); suspend/resume; missing, invalid, and incomplete captures; failed capture, persistence, and restore; extension restart mid-operation; stale messages (test handle replays an old-generation reply); user closes the tab during capture and during restore; two dashboards issuing commands at once; unexpected windows; normal-tab rejection; browser restart then Resume of a saved identity; the normal profile's sentinels unchanged throughout; a 10,000-record database (record its approximate size) with timings.

**Gate G3 — data fidelity and capture consistency verdicts.** `vp run verify`, report section, verdicts. Stop only on NO-GO (OD-3).

### Stage 4 — PWA compatibility and Zephyr

**S4.1 PWA fixture and native baseline.** `/pwa/` as in §8. Spec in a plain managed Incognito window, no restore: registration, activation, `controller` after `clients.claim`, worker-initiated authenticated fetch, worker IndexedDB and Cache Storage, offline reload after activation (server-side offline switch). Separates browser limits from RECnRun regressions. Red/green.

**S4.2 PWA through switches.** A → B → A → C → A on `/pwa/`: first app reads, worker responses, and authenticated requests belong to the active identity; first load, controlled reload, and an app-version change tested separately; offline after reinstall versus resuming while already offline, reported separately. The worker re-registers itself; nothing disables it. Red/green.

**S4.3 Declared capability: additional cookie hosts.** Identity config lists extra cookie hosts (SSO). Fixture `sso.localhost`: HttpOnly session, silent redirect when present, login page otherwise. Control: without the capability, B is silently signed in as A, or not signed in at all after resume. Host permissions only for declared hosts. Red/green.

**S4.4 Zephyr manual run (needs the user).** A development build with `RECNRUN_POC_HOSTS=https://zephyr-tq.one.be,https://login-acc.one.be` and a script `vp run poc:zephyr` that opens headed Chrome with a fresh profile; the user turns on "Allow in Incognito" by hand. Runbook in the report: native Incognito baseline first (sign-in, SW, offline), then A → B → A → C → A with the user's test accounts, checking the shown account, worker responses, authenticated calls, and the normal profile's own Zephyr login. Record names, counts, sizes, timings, never values; delete captures afterwards. Without the user's run, Zephyr is "not validated".

**S4.5 Zephyr results.** Report section and verdict.

### Stage 5 — Measurements, documents, delivery

**D.1 Timings.** Aggregate capture, transport, persistence, teardown, bootstrap, restore, PWA readiness, and total switch time (median, p95, max) from the recorded runs, plus the 10,000-record database size.

**D.2 Durable docs.** `ARCHITECTURE.md` (new folders and rules, the page-origin agent, barrier, journal, Incognito lifecycle, security model change, the limit that events cannot stop other windows), `PRODUCT_BRIEF.md` (normal tabs not recordable, Pause vs Suspend vs Resume, local persistence and deletion), `POCS.md` entry, `TROUBLESHOOTING.md` for anything that took investigation. `.dependency-cruiser.cjs` already changed with S2.4.

**D.3 Report.** `docs/POC-ORIGIN-SNAPSHOT.md` complete per §10.

**D.4 Final gate.** `vp run verify` exits 0; run id recorded; checklist complete.

### Optional — reused Incognito context comparison

**C.1** Only after G3 has results, or if a primary-route blocker justifies it, and only with the user's go-ahead: bounded experiment keeping the Incognito context and clearing/replacing state in place. Compare runtime compatibility, fidelity, first load, code size, and switch latency against the primary route. Avoiding a visible window close is not a reason to choose it.

## 10. Report structure (`docs/POC-ORIGIN-SNAPSHOT.md`)

1. Status and verdicts table (six areas: GO / CONDITIONAL GO / NO-GO / not validated)
2. Base and source commits (RECnRun base, branch head, SplitSession `475afe8`), environment (host OS and Chrome, Docker Chromium, Playwright, WXT)
3. Permissions per build and why
4. Stage 1–4 sections: commands, repeat counts, negative controls with their observed failures, results, restrictions
5. Timings table
6. Supported claims and explicit non-claims (memory, sockets, running worker, post-cutoff writes, second tab, other extensions opening windows)
7. Recommendation and next decisions

## 11. Execution protocol

- The main session orchestrates: it delegates task ids to `plan-implementer` (one or a few consecutive tasks per run), reviews each commit, runs `vp run verify` at each stage end, and marks tasks `[x]` in the checklist.
- Tasks run in order; the only parallel-safe pairs are noted in the checklist.
- Gates G1 and G2 stop for the user. A NO-GO stops expansion at any gate.
- Commits follow `AGENTS.md` (subject, `Red:`/`Green:` or `No-behavior-change:`); never bypass hooks; never push or open a PR without the user's word.
- Manual tasks (S4.4) are marked `[manual]`; the orchestrator prepares them and asks the user to run them.
