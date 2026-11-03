# RECnRun local engine: implementation plan

Plan date: 2026-11-02. Source: the Portuguese execution plan written on 2026-11-01, kept verbatim in [source-2026-11-01.pt-BR.md](source-2026-11-01.pt-BR.md) ("the source plan"). This document turns it into phases, tasks, and acceptance criteria that `vp run verify` can check without a person at the keyboard. Everything that needs a person is listed in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md) and is scheduled after the automated gates. Progress is tracked in [CHECKLIST.md](CHECKLIST.md).

Rules of the repository ([AGENTS.md](../../AGENTS.md)) apply to every task: red/green tests, one commit per task, exercise each change, `vp run verify` exits 0 before a phase closes.

## 1. What the source plan asks for

A local tool that lets a tester or an agent drive the installed Google Chrome, turn the interaction into a persistent declarative flow (YAML/JSON), and replay it with no AI involved. Confirmed requirements (source §1):

| Req | Summary                                                                                             | Where this plan proves it                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R1  | Record, edit, assert, parameterize, save, reopen, run, and investigate without AI or code           | F2 gate, F4 gate                                                                             |
| R2  | Real installed Chrome, including the default and other existing profiles                            | F1 (Docker: Google Chrome Stable for Linux); default profile and profile picker: manual M-F1 |
| R3  | CDP and the debugger banner are accepted                                                            | F1.1, F1.2                                                                                   |
| R4  | Capture actions, navigations, network and bodies, console, errors, storage within declared coverage | F1.5, F3, F6                                                                                 |
| R5  | Declarative flow separate from evidence; no TypeScript test per flow                                | F0.3, F2.4, F2.5                                                                             |
| R6  | Humans and agents share one engine and hand control over mid-session                                | F2.2, F5.4                                                                                   |
| R7  | The tool investigates its own defects; the failing scenario becomes the first regression            | F5.5, F5.6, §7                                                                               |
| R8  | Windows and macOS in one or two commands plus Chrome's own confirmations                            | F7 (Linux clean install automated; Windows/macOS manual M-F7)                                |
| R9  | Locator lists, registered JavaScript functions, macros with loops, conditionals, counters           | F4A                                                                                          |

## 2. Decisions

These change what M0 built. Each is recorded as an ADR in `docs/adr/` during F0.1.

1. **Architecture.** Node.js + TypeScript local service, CDP connection to the installed Chrome, UI served on localhost, CLI through `npx`, MCP and skills optional. The source plan defines this; the spike (F1) validates its limits, it does not choose between alternatives.
2. **The extension and the bridge are retired.** The local service owns the data; a browser extension no longer does. `apps/extension` and `packages/bridge` are deleted in F0.1 (history stays on `master` and in the archive tags). `apps/website` becomes the public landing and install guide for the npm package; the localhost UI is a separate app.
3. **Runtime matrix.** Node.js 24 LTS is the official runtime (CI and Docker); `engines.node` stays `>=22.18.0` because `node:sqlite` needs 22.13 or later. Google Chrome 144 or later is required for the authorized connection to a running Chrome (`chrome://inspect/#remote-debugging`); the machine used for this plan runs Chrome 156.0.8078.76.
4. **Connection discovery.** Chrome writes `<user-data-dir>/DevToolsActivePort` (port, then WebSocket path) when remote debugging is on, whether enabled by the user in `chrome://inspect/#remote-debugging` or by `--remote-debugging-port=0` on a non-default `--user-data-dir`. The adapter reads that file and connects to `ws://127.0.0.1:<port><path>`, the same algorithm `chrome-devtools-mcp` uses (`src/BrowserManager.ts`, commit `aade3be`, 2026-11-02). Chrome shows its permission dialog and banner on the first path; the second path, used in Docker, shows none. Only the dialog and the toggle are manual.
5. **Automated browser target.** The Docker test image installs Google Chrome Stable for Linux (not Chromium, not Chrome for Testing) and starts it headed on Xvfb with a throwaway `--user-data-dir`. Every browser-facing gate runs there. Results are reported as "Google Chrome <version> on Linux", never as validation of the default profile on Windows or macOS.
6. **Libraries.** Playwright 1.64.1 `connectOverCDP` for actions and assertions over the CDP endpoint, raw CDP sessions for instrumentation; Valibot for schemas, with JSON Schema exported through `@valibot/to-json-schema` and committed; `node:sqlite` for the local index (no native build); `ws` for the service WebSocket; Preact for the UI; YAML parsing through `yaml`.
7. **Package name.** `@recnrun/cli` (free on npm on 2026-11-02, as is `recnrun`). Publishing is manual and needs the owner's authorization (M-F7.c).
8. **No egress.** The service, CLI, and MCP never open a connection to a host other than loopback. Tests run with `RECNRUN_FORBID_EGRESS=1`, which makes any such connection throw; this is how "no AI call" is checked.

## 3. How acceptance is checked

- Every acceptance criterion names a test file and the `vp run` command that runs it. A criterion with no automated check does not close a task; it goes to [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md).
- A phase closes when its tasks are `[x]` in [CHECKLIST.md](CHECKLIST.md) and `vp run verify` exits 0 on the branch. Manual items never block a phase; they block the release gate (F7.4).
- New test layers added by this plan, all run by `vp run verify` inside Docker:

| Layer        | Files                                                                              | Command                    | Added in |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------- | -------- |
| Unit         | `{apps,packages}/*/tests/*.test.ts`                                                | `vp run test:unit`         | exists   |
| Component    | `*.browser.test.tsx`                                                               | `vp run test:components`   | exists   |
| Browser      | `tests/browser/*.spec.ts`: engine against Google Chrome over CDP, fixture app      | `vp run test:browser`      | F0.6     |
| End to end   | `tests/e2e/*.spec.ts`: UI, service, CLI, Chrome together                           | `vp run test:e2e`          | exists   |
| Contract     | `tests/contract/*.test.ts`: HTTP/WS API, MCP over stdio, deterministic clients     | `vp run test:contract`     | F2.1     |
| Distribution | `tests/distribution/*.mjs`: pack the CLI, install the tarball in a clean container | `vp run test:distribution` | F7.1     |
| Docs         | `scripts/check-docs.mjs`: links resolve, generated tables are current              | `vp run docs:check`        | F0.1     |

- Coverage thresholds (80/80/80/75), Knip, jscpd (4%), lint caps, and the architecture rules apply to every new package.
- Capture coverage is itself an artifact: every run writes `coverage.json` (capabilities, gaps, losses). Tests assert on it, so "declared coverage" is checked, not described.

## 4. Target layout

Workspaces stay `apps/*` and `packages/*`. Arrows are allowed imports; `.dependency-cruiser.cjs` enforces them (F0.2).

```text
apps/cli ──► apps/service ──► packages/engine ──► packages/protocol ──► valibot
   │              │              │    ▲
   │              │              ▼    │
   │              ├──► packages/adapter ──► playwright-core, CDP
   │              └──► packages/persistence ──► node:sqlite, node:fs
apps/ui ──► packages/protocol (types and schemas only), @recnrun/brand
apps/website ──► @recnrun/brand (landing and install guide; no engine code)
apps/fixture: the controllable test application; nothing imports it
```

| Workspace              | Holds (source plan component)                                                                                                          | May import                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/protocol`    | `protocol`: flow DSL, locator lists, event envelope, run manifest/summary/coverage, capability matrix, service API, MCP shapes         | `valibot`                                      |
| `packages/engine`      | `core`, `recorder` normalization, `function-registry`, `macro-runtime`: sessions, leases, steps, resolution policy, interpolation      | `protocol`                                     |
| `packages/adapter`     | `browser-adapter`, `instrumentation`: discovery, CDP connection, targets/frames, actions, hooks, element references                    | `protocol`, `playwright-core`                  |
| `packages/persistence` | `persistence`: flow folders, revisions, JSONL journal, blobs by hash, SQLite index, export/import                                      | `protocol`                                     |
| `apps/service`         | `coordinator`, `mcp`: loopback HTTP+WS API, locks, lifecycle, logs, MCP stdio adapter, serves the built UI                             | `engine`, `adapter`, `persistence`, `protocol` |
| `apps/ui`              | `web-ui`: Preact SPA on localhost (catalog, recorder, editor, run, diagnostics, catalogs)                                              | `protocol`, `brand`                            |
| `apps/cli`             | `cli`: `setup`, `open`, `run`, `doctor`, `agents setup`, `mcp`; the published `@recnrun/cli`                                           | `service`                                      |
| `apps/fixture`         | The deliberately controllable test application (source §19)                                                                            | nothing from the workspace                     |
| `packages/brand`       | unchanged                                                                                                                              | nothing                                        |
| `.agents/skills/`      | `skills`: `recnrun-create-flow`, `recnrun-replay-flow`, `recnrun-investigate-run`, `recnrun-improve-tool`; copied into the CLI package | n/a                                            |

Engine code never imports Playwright or CDP types: the adapter exposes an interface defined in `engine`, so unit tests use a fake adapter and browser tests use the real one.

## 5. Phases

Task IDs are stable; the checklist uses them. "Accept" lines are the automated checks. "Manual" lines name the deferred items in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md).

### F0: Contracts and skeleton

Goal: the repository matches §2 and §4, the schemas exist, the fixture app exists, Docker has Google Chrome.

- **F0.1 ADRs and repository reshaping.** Write `docs/adr/0001-local-service-over-cdp.md` (architecture, decisions 1 to 8) and `docs/adr/0002-retire-extension-and-bridge.md`. Delete `apps/extension` and `packages/bridge`; keep `apps/website` as landing. Rewrite `docs/PRODUCT_BRIEF.md`, `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, `.claude/rules/*.md`, `AGENTS.md`, and the `adding-a-bridge-message` skill (replaced by `adding-a-service-command`). Add `scripts/check-docs.mjs` (every relative Markdown link resolves; anchors exist) wired as `vp run docs:check` inside `verify`.
  Accept: `vp run docs:check` fails on a broken link in a scratch copy and passes on the branch; `vp run verify` exits 0 with the extension gone.
- **F0.2 Workspace skeleton.** Create `packages/protocol`, `packages/engine`, `packages/adapter`, `packages/persistence`, `apps/service`, `apps/ui`, `apps/cli`, `apps/fixture` with `package.json`, `tsconfig`, Vitest projects, `knip.jsonc`, jscpd paths, coverage includes, and the dependency-cruiser rules of §4 (`engine-not-to-adapter-impl`, `protocol-pure`, `ui-only-protocol`, `fixture-isolated`, `cli-only-service`). Each package has one real module and one test so `no-orphans` holds.
  Accept: `vp run deps` fails in a scratch copy where `packages/engine` imports `playwright-core`, passes on the branch.
- **F0.3 Protocol schemas v1.** Valibot schemas for: `Flow` (schemaVersion 1, id, name, actors, inputs, requirements, preconditions, steps), step kinds (`action`, `assertion`, `builtin`), target as a one-item shorthand or a locator list (`resolution`, `cardinality`, `timeoutMs`, `locators[]`), interpolation grammar (`${env.*}`, `${inputs.*}`, `${vars.*}`, `${locals.*}`, `${secrets.*}` only), event envelope (source §11), run `manifest`, `steps`, `coverage`, `summary`, capability matrix, session/control/step states (source §6), service API commands and results. Export JSON Schema to `packages/protocol/schema/*.json` with a drift test.
  Accept: `packages/protocol/tests/flow.test.ts` parses both YAML examples of the source plan (§9, §9.3) and rejects fixtures with an unknown action, an unknown interpolation namespace, a duplicate step id, a missing required input, a cyclic variable reference, and `cardinality: nth` without an index; `schema-drift.test.ts` fails when a schema changes without regenerating the JSON.
- **F0.4 Capability matrix as code.** `packages/protocol/src/capabilities.ts` lists every capture surface and feature of the source plan (§10, §9) with a status (`implemented`, `partial`, `unavailable`, `planned`) and the phase that changes it. `docs/CAPABILITIES.md` is generated from it.
  Accept: `vp run docs:check` fails when the table and the code differ; the service `capabilities.get` result (F2.1) equals the matrix.
- **F0.5 Fixture application.** `apps/fixture` serves, on two ports (second origin for iframes), routes for: form (text, select, checkbox, radio, file), debounce input, SPA route change, traditional submit with redirect, cross-origin iframe, popup window, virtualized list, IME-like composition events, IndexedDB with commit and abort, service worker with Cache Storage, network cases (JSON, binary, 500, redirect chain, slow stream, WebSocket echo), console log/warn/error and unhandled rejection, download, `alert`/`confirm`, localStorage/sessionStorage/cookie operations, and a `?fail=<case>` switch that injects a defect on demand. Every control has a stable `data-testid` and an accessible name.
  Accept: `tests/browser/fixture.spec.ts` opens each route in Chrome and checks its self-test flag; later phases depend on these routes.
- **F0.6 Google Chrome in Docker and the browser layer.** `Dockerfile.tests` installs Google Chrome Stable for Linux and records its version into `.artifacts/docker/<run>/versions.json`. `tests/browser/fixtures/chrome.ts` launches Chrome headed on Xvfb with `--user-data-dir=<tmp> --remote-debugging-port=0 --no-first-run`, waits for `DevToolsActivePort`, and tears down. `vp run test:browser` runs `tests/browser/*.spec.ts` in Docker; `tests/container/runner.checks.mjs` asserts the image reports `Google Chrome` and a version of 144 or more.
  Accept: `tests/browser/chrome-fixture.spec.ts` gets a `DevToolsActivePort` with two non-empty lines; `tests/container/runner.checks.mjs` passes.

Gate F0: `vp run verify` exits 0; §1 table rows all point at F-tasks (this document); ADRs committed.

### F1: Connection and fidelity spike

Goal: prove, against Google Chrome in Docker, the six mandatory proofs of the source plan §4 and the function-locator path, and write the spike report. Macos/Windows default-profile proofs are M-F1.

- **F1.1 Discovery.** `adapter.discover({ userDataDir | channel })`: default user-data-dir per OS and channel (macOS `~/Library/Application Support/Google/Chrome`, Windows `%LOCALAPPDATA%\Google\Chrome\User Data`, Linux `~/.config/google-chrome`; `Beta`, `Dev`, `Canary` variants), read and validate `DevToolsActivePort`, return `{ wsEndpoint, userDataDir, source: "active-port-file" }`. Errors name the remedy ("enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open").
  Accept: unit tests with temporary directories (valid file, missing file, malformed port, stale file with closed port); `tests/browser/discover.spec.ts` resolves the Docker Chrome.
- **F1.2 Connection and handshake.** `adapter.connect(endpoint)`: Playwright `connectOverCDP`, a browser-level CDP session, `Browser.getVersion`, protocol version, capability probe; `disconnected` handling emits `connection.lost` with a gap record; reconnect only when the same `DevToolsActivePort` is valid again; detect an already attached debugger on a target (DevTools open) and report `control.contested` instead of detaching it.
  Accept: `tests/browser/connect.spec.ts`: connect, list targets, `kill -9` Chrome → `connection.lost` + gap in `coverage.json`, restart Chrome → reconnect succeeds; open DevTools on a page via CDP (`Target.attachToTarget` from a second client) → `control.contested` reported, no detach.
- **F1.3 Profiles as bindings.** Each connection is a `ProfileBinding` (friendly name chosen by the user, `userDataDir`, `browserContextId`s observed, Chrome version). Two Docker Chrome instances with two user-data-dirs are two bindings. Bindings live in `~/.recnrun/bindings.json`, never inside a flow package. Duplicate or stale binding detection: same endpoint twice, endpoint whose Chrome restarted.
  Accept: `tests/browser/profiles.spec.ts`: localStorage and a cookie set through binding A are absent in binding B; a flow with two actors runs each step on the right binding; a stale binding is reported, not silently remapped. Manual: M-F1.c (two profiles inside one Chrome instance).
- **F1.4 Instrumentation installation order.** `Target.setAutoAttach` (flatten, `waitForDebuggerOnStart`), `Page.addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`, then `Runtime.runIfWaitingForDebugger`, for existing and new targets; hooks run before the application's first script; events carry `targetId`, `frameId`, `documentId`, source sequence; the service validates every binding message with the protocol schema and drops messages from unknown frames.
  Accept: `tests/browser/instrumentation.spec.ts`: the fixture's head script finds the hook already installed on reload, SPA navigation, same-origin iframe, cross-origin iframe (OOPIF), popup; a forged binding message from the page is dropped and counted; `coverage.json` marks dedicated workers as `partial` or `implemented` according to what was observed.
- **F1.5 Raw capture.** DOM raw events (pointer, click, keydown/keyup, input/change, composition, selection, focus, scroll, submit, dialog), `Network.*` (request, response, bodies with condition `captured | truncated | unavailable | not-requested`, failures, redirects), `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, navigation and target lifecycle. Everything lands in the journal with the §11 envelope.
  Accept: `tests/browser/capture.spec.ts`: scripted interactions on the fixture produce the expected raw event sequence (golden file), a JSON body is `captured`, the slow stream is `unavailable` with reason, a 500 and a redirect chain appear with status and chain, console error and unhandled rejection appear.
- **F1.6 Replay spike.** Run the source plan's first YAML example, adapted to the fixture, through the adapter: `navigate`, `fill`, `click`, `extractText`, `textEquals`. Actions go through Playwright input methods (real input events), never `.value =`.
  Accept: `tests/browser/replay-spike.spec.ts` passes; the fixture's `?fail=status` switch makes exactly the assertion step fail with evidence.
- **F1.7 Custom locator function path.** Run a JavaScript locator in an isolated world (`Page.createIsolatedWorld`), convert returned elements to qualified element references (target/frame/document + remote object), apply cardinality rules, release handles; `error` status on exception; `Runtime.terminateExecution` for a synchronous infinite loop, with the outcome recorded (recovered without closing the tab, or not).
  Accept: `tests/browser/function-locator.spec.ts`: zero, one, many results; throwing function → `error`; `while(true)` function → terminated within the deadline and the tab still answers `Runtime.evaluate`, or the test documents the real outcome in `coverage.json` and the spike report.
- **F1.8 Spike report.** `docs/spikes/2026-11-f1-cdp-connection.md`: versions (Node, Chrome, Playwright, protocol), connection procedure, proofs with their test names, observed limits, capability matrix updates, estimate of F2 to F7 based on what was proved (source §20).
  Accept: `vp run docs:check` passes; every "observed" claim cites a test file.

Gate F1: `vp run verify` exits 0 with `test:browser` in it; report committed. Manual (not blocking): M-F1.a, M-F1.b, M-F1.c, M-F1.d.

### F2: First vertical flow without AI

Goal: record, add an assertion, stop, close the tool, reopen it, replay, all from the localhost UI, with no AI and no code edited.

- **F2.1 Service.** `apps/service`: loopback-only HTTP and WebSocket; per-user state in `~/.recnrun/` (`service.json` with port and token, mode 0600); bearer token on every request; `Origin` and `Host` validation; one instance per user (lock file, stale lock recovery); structured logs on disk with rotation; `SIGTERM` drains journals; `capabilities.get`, `health`. API shapes come from `protocol`.
  Accept: `tests/contract/service-auth.test.ts`: no token → 401, wrong `Origin` → 403, WebSocket without token closed with 4401, second start reuses the running instance, `SIGTERM` during a write leaves a readable journal.
- **F2.2 Sessions, control, leases.** Engine state machines of source §6 (session, control, step), exclusive control per target with lease, heartbeat, fencing token; a command with an old token is rejected; pause semantics are three distinct operations (`pauseStepCreation`, `pauseReplay`, `suspendCapture`).
  Accept: `packages/engine/tests/session.test.ts` covers every transition and rejects every illegal one; `lease.test.ts` rejects a delayed command from a previous lease.
- **F2.3 Normalization.** Pure module: raw events → suggested steps with their raw event ids (`fill` grouping, `type` when per-key behavior matters, no duplicate `navigate` after a click, scroll policy, double click, drag, shortcuts, composition, recorder overlay excluded, `commandId`-correlated events marked as replay-caused, actor not inferred from `isTrusted`).
  Accept: golden tests `packages/engine/tests/normalization/*.json`: one input/expected pair per rule above; a mutated expectation fails.
- **F2.4 Flow persistence.** Folder layout of source §12 (`flow.yaml`, `manifest.json`, `requirements.md`, `datasets/`, `revisions/`, `runs/<id>/…`); YAML ↔ canonical JSON round trip; every edit writes an immutable revision; runs reference the revision hash; atomic metadata writes; journal tolerant of a truncated last line; SQLite index rebuilt from folders.
  Accept: `packages/persistence/tests/*.test.ts`: round trip is byte-stable, a truncated `events.jsonl` loads with a `gap`, deleting the SQLite file and reopening rebuilds the catalog identically.
- **F2.5 Replay executor.** Sequential steps, condition-based waits (no `networkidle` default), actions `navigate`, `reload`, `click`, `fill`, `type`, `select`, `check`, `uncheck`, `keyPress`, `scroll`, `openTab`, `selectTab`, `closeTab`, `waitFor`; assertions `visible`, `hidden`, `textEquals`, `textContains`, `value`, `enabled`, `disabled`, `count`, `url`; `extractText`, `extractAttribute`; variables and interpolation; timeouts; `steps.json`, `summary.json`, exit code. Write actions are never retried blindly; locating and asserting may poll.
  Accept: `tests/browser/replay.spec.ts`: one flow per action and assertion against the fixture; an action whose dispatch succeeded but whose condition failed yields `failed` with no second dispatch (counted by the fixture).
- **F2.6 Minimal UI.** `apps/ui` screens: Setup/Doctor (connection, bindings, versions), Catalog, Recorder (start/pause/stop, coverage, take control), Editor (step cards, delete, add assertion through the picker or a form, timeout), Run (inputs, live steps, stop, result). Picker overlay runs in an isolated world and never triggers the application's handlers.
  Accept: component tests per screen; `tests/e2e/first-flow.spec.ts` in Docker: start the service, open the UI, start recording, drive the fixture through a second CDP client (stands in for the human), add an assertion with the picker, stop, kill and restart the service, reopen the flow, replay → `passed`; `RECNRUN_FORBID_EGRESS=1` is on; the picker test clicks a fixture button in select mode and the button's counter stays at 0.
- **F2.7 CLI (local).** `recnrun open --no-browser`, `recnrun run --flow <dir> --dataset <name>` (exit 0/1/2 for passed/failed/error, JSON summary on stdout), `recnrun doctor` (Node, Chrome, `DevToolsActivePort`, bindings, disk, versions) with `--json`.
  Accept: `tests/contract/cli.test.ts`: `run` returns 1 on the `?fail=status` fixture and 0 otherwise; `doctor --json` reports `remoteDebugging: "not-found"` when no `DevToolsActivePort` exists and the remedy text.

Gate F2: `tests/e2e/first-flow.spec.ts` green, `vp run verify` exits 0. Manual: M-F2.a.

### F3: Diagnostics and robust persistence

- **F3.1 Network evidence.** Headers, timing, cache state, failures, redirect chains, WebSocket frames (truncation and encoding flagged), bodies as blobs by sha256 with MIME, encoding, size, and condition; size caps and redaction before persistence.
  Accept: `tests/browser/network.spec.ts` on the fixture's network routes; a body above the cap is `truncated` with the original size; a redacted header is `redacted`.
- **F3.2 Console and errors.** Serialization limits for remote objects at capture time; stack traces when available.
  Accept: `tests/browser/console.spec.ts`.
- **F3.3 Snapshots and screenshots.** DOM snapshot and screenshot at milestones, before and after each action, and on failure; stored as blobs and referenced from steps.
  Accept: `tests/browser/snapshots.spec.ts`: a failed step has before/after/failure images; the viewer in the UI renders captured HTML inside a sandboxed frame with no script execution (`tests/e2e/viewer-sandbox.spec.ts`: an injected `<script>` in captured HTML does not run).
- **F3.4 Storage, normal level.** `DOMStorage` events, cookie changes through CDP, hooks for `localStorage`/`sessionStorage` operations; events distinguish `observed-operation` from `snapshot`.
  Accept: `tests/browser/storage.spec.ts` on the fixture's storage route.
- **F3.5 Coverage and loss accounting.** Bounded observer buffers that emit explicit `gap` events when exhausted; durable ACK, per-producer sequence, deduplication, resend window; `coverage.json` per run with surfaces × status × reasons; UI shows gaps.
  Accept: `tests/browser/coverage.spec.ts`: with a 10-event buffer and a burst of 1000 events, `gap` events account for every missing sequence; `kill -9` Chrome mid-run produces a `connection.lost` gap; counts in `coverage.json` reconcile with the journal.
- **F3.6 Crash recovery.** `kill -9` of the service mid-run → on restart the run is `interrupted`, inspectable, nothing is re-executed; in-flight write steps are `indeterminate`.
  Accept: `tests/contract/recovery.test.ts`.
- **F3.7 Diagnostics UI.** Timeline with filters (profile, step, origin, category, coverage), request/response pairing, storage operations with transaction state, `causalConfidence` labels, baseline vs failing run comparison that points at the first observable divergence.
  Accept: component tests; `tests/e2e/diagnostics.spec.ts`: run the fixture flow twice, once with `?fail=api-500`; the comparison names the 500 response as the first divergence and the UI does not blame the application for a collector gap (a run with an injected gap shows "collector gap", not "application failure").
- **F3.8 `run.compare` and `run.queryEvents` API.** Paginated, filterable.
  Accept: `tests/contract/runs-api.test.ts`.
- **F3.9 Overhead benchmark.** `scripts/bench-capture.mjs`: fixture under no instrumentation, Normal, Deep; reports latency, CPU, memory, events per second, loss, trace size into `.artifacts/`; a bounded-memory test (heap after 50 000 events stays under a fixed budget).
  Accept: `tests/browser/bench-smoke.spec.ts` runs the bench for 30 seconds and asserts the report exists, loss is zero or fully accounted as gaps, and memory is bounded. Targets (1 s UI progress, 30-minute recording) are reported as measurements, not gates; the 30-minute soak is `scripts/soak-capture.mjs`, run on demand (M-F3.a).

- **F3.10 Desktop-driven validation.** Added 2026-11-03 after Gate F3. A `tests/desktop` Playwright project that runs only in the container, where `xdotool` and `scrot` on the Xvfb display drive what CDP cannot reach: Chrome's own windows and dialogs. On a fresh Google Chrome profile (never the default one or `~/.recnrun`) it turns remote debugging on through `chrome://inspect/#remote-debugging`, starts the real CLI `open`, records on the fixture, answers Chrome's connection dialog, keeps a screenshot of that dialog and of the "controlled by automated test software" banner, adds an assertion with the picker, stops, restarts the service, replays, clicks the replay's tab as a person would, and opens the run's diagnostics. It reuses the lessons of the archived POC driver (`tests/e2e/fixtures/native-dialogs.ts` and `display.ts` at `origin/poc/multi-profile-mesh`, 60989d6): find windows by title with `xdotool search --sync` after giving the page a unique `document.title`; focus every window explicitly, since there is no window manager; bring the page to the front once before the first dialog and never raise it again; detect bubbles by a pixel of the display (`scrot -a x,y,1,1`), not by window; answer a focused prompt from the keyboard and an unfocused one by click; treat `BadWindow` from Ubuntu's xdotool 3.20160805 as "search again" (stderr tells it from no match); turn Playwright's file-chooser interception off per page when a native picker is involved; guard the driver with `RECNRUN_TEST_CONTAINER`; keep a `scrot` of the display on failure.
  Accept: `tests/desktop/first-use.spec.ts` passes in Docker (`vp run test:desktop`, part of `verify`) with the screenshots under the test's output; the suite is skipped with a clear message outside the container. macOS and Windows stay manual (M-F1.a, M-F1.b, M-F2.a): the desktop layer proves the flow on Linux, not the platform.

- **F3.11 One connection per Chrome.** Added 2026-11-03 from the F3.10 finding: Chrome asks "Allow remote debugging?" at every new CDP WebSocket, and one recording with the picker plus one replay opened five (preflight, Playwright, recording, picker, evidence). The service holds one browser connection per Chrome for its lifetime and every feature shares it: the recording's instrumentation, the picker, the replay's evidence channel, and the handshake multiplex sessions over one flat browser socket (`Target.attachToTarget` with `flatten`, each owner filtering by its own session ids, so the picker's attach never reaches the recording's scope); the replay driver reuses one Playwright `connectOverCDP` per Chrome, or runs over the shared socket if Playwright's `newBrowserCDPSession` carries foreign sessions (decide from `playwright-core`'s source and record the reason). The connection closes at shutdown; a lost connection is reconnected on the next use (Chrome asks again, which is unavoidable) and the `connection-lost` gap semantics stay. A person sees the dialog once per Chrome and service start, twice at most when Playwright must own a socket.
  Accept: `tests/desktop/first-use.spec.ts` asserts the dialog count for one recording with the picker plus one replay (at most 1 for the test's own connection plus the agreed number, 1 or 2); `packages/adapter/tests` cover session multiplexing, owner isolation, shutdown, and reconnection after loss; browser, e2e, and contract layers unchanged in outcome.

Gate F3: `vp run verify` exits 0; `docs/CAPABILITIES.md` regenerated.

### F4: Editor, parameters, multiple profiles, import/export

- **F4.1 Full editor.** Add, remove, reorder; target picker with candidate list; edit inputs; insert assertions and waits; timeout; requirement links; actor change; parameterize a literal into an input; duplicate flow; revision comparison. Every change creates a revision; past runs keep theirs.
  Accept: component tests; `tests/e2e/editor.spec.ts`.
- **F4.2 Inputs, datasets, preconditions, variables.** Typed inputs, datasets without secrets, `authenticated: <actor>` precondition with a declared check (URL, visible element, or function), scoped variables, extraction.
  Accept: `packages/engine/tests/preconditions.test.ts`; `tests/browser/preconditions.spec.ts`: an expired-session fixture state fails the precondition before any step runs.
- **F4.3 Actors and bindings.** Portable roles in the flow, local bindings outside the package; A creates, B approves, A verifies on two Chrome instances; shared variables with explicit scope; locks that stop concurrent storage resets on the same origin and profile.
  Accept: `tests/browser/multi-profile.spec.ts`.
- **F4.4 Export and import.** `.recnrun.zip` with inventory and hashes; import validates schema, sizes, paths, and compatibility; path traversal and decompression-ratio limits; secrets are `${secrets.<name>}` references resolved from the local store and never serialized; bindings and `baseUrl` remapped on import; evidence selection on export; sanitized diagnostic export separate from flow export.
  Accept: `packages/persistence/tests/export.test.ts` and `tests/security/zip.test.ts` (traversal entry rejected, ratio bomb rejected, literal secret never present in the archive).
- **F4.5 Flow status and requirement coverage.** `draft`, `recorded`, `validated-by-replay`, `incompatible`, `needs-review`; each requirement is `covered`, `missing`, or `not-verifiable`; a recording is not a validated test until a replay passes.
  Accept: `packages/engine/tests/flow-status.test.ts`; UI shows the states (component test).
- **F4.6 Initial state and scoped reset.** Flow declares its strategy (existing session, login subflow, data preparation, supported snapshot); reset only the authorized origin's storage, as an explicit operation; per-run unique identifiers helper; failure data preserved.
  Accept: `tests/browser/reset.spec.ts`: a reset of origin A leaves origin B and other profiles untouched.

Gate F4: `tests/e2e/export-import.spec.ts`: the A-B-A flow is exported, imported into a fresh `~/.recnrun` with different bindings and `baseUrl`, replayed → `passed`. Manual: M-F4.a.

### F4A: Locator lists, function registry, macros

- **F4A.1 Locator resolution.** Statuses `matched`, `not-found`, `ambiguous`, `unsupported`, `error` with count, duration, evidence; `orderedFallback` (advance only on `not-found`) and `agreement`; one shared deadline; `one`, `many`, `optional`, `nth`; composition `within`, `filter`, `has`; `locatorAttempt` trace with the winning strategy; no second strategy after a dispatched action fails.
  Accept: `packages/engine/tests/locators.test.ts` with a fake adapter and `tests/browser/locators.spec.ts` on the fixture, covering the source plan's §19 list: first absent and second correct; ambiguity in the first; error in a custom locator; divergence in `agreement`; global timeout; no duplicate click after dispatch.
- **F4A.2 Function registry.** Manifest (namespaced id, version, description, type `locator | predicate | transform | macro`, entry, environment, input/output schemas, capabilities, limits, dependencies); immutable content per version with hash; `functions.lock.json`; register does not execute; catalog list and search; no `latest` during replay; frozen versions per run.
  Accept: `packages/engine/tests/registry.test.ts`: wrong hash rejected, missing dependency rejected, `latest` rejected at replay, same id and version with different content rejected.
- **F4A.3 Function runtimes.** `page` environment in an isolated world with element reference conversion and `Runtime.terminateExecution`; `engine-worker` environment in `worker_threads` with resource limits and a mediated SDK only (documented honestly: `worker_threads` is isolation of state and cancellation, not a security sandbox).
  Accept: `tests/browser/function-runtime.spec.ts`: sync and async functions, invalid return, cancellation of a blocking page function, cancellation of a blocking worker function, worker cannot reach `fs` or `net` through the SDK.
- **F4A.4 Macro runtime.** `if/else` (exception is an error, not `false`), `repeat`, `forEach` (data list or element collection, stable keys re-resolved per item), `while`/`until` with mandatory limits and deadline, `counter`, `setVariable`, `call`, `break`, `continue`; hierarchical trace (`callId`, `parentCallId`, `iterationId`, `stepPath`); limits on depth, total actions, time; interruption after an effect → `indeterminate`, no blind retry.
  Accept: `packages/engine/tests/macros.test.ts`: zero/one/many iterations, false and throwing conditions, iteration and time limits, counter scoping, nested macro, depth exceeded, interruption after effect; `tests/browser/macro-loop.spec.ts` runs the source plan's §9.3 example on the fixture list.
- **F4A.5 Macro SDK.** `ctx.actions.*`, `ctx.assertions.*`, `ctx.functions.call`, `ctx.vars`, producing child steps and events with redaction.
  Accept: `tests/browser/macro-sdk.spec.ts`: every SDK action appears as a child step with its evidence.
- **F4A.6 UI for locators, functions, blocks.** Locator editor (ordered list, per-strategy preview, policy and cardinality, divergences), function catalog, advanced JavaScript editor (register, test, version, compare), visual control blocks, "Extract macro" from selected steps.
  Accept: component tests; `tests/e2e/locators-functions.spec.ts`.
- **F4A.7 Function export and import.** Modules, manifests, lockfile in the package; import on a clean data dir resolves names, detects collisions and incompatible versions, never downloads.
  Accept: `packages/persistence/tests/function-export.test.ts`; `RECNRUN_FORBID_EGRESS=1` holds.
- **F4A.8 Promotion to built-in.** Procedure of source §9.4 as `docs/PROMOTING_FUNCTIONS.md`, exercised once: a generic locator (row button by key) promoted to a versioned built-in while the original function, its test, and flows pinned to it keep passing.
  Accept: `packages/engine/tests/builtins/row-button-by-key.test.ts` plus the preserved original regression.

Gate F4A: `tests/e2e/locators-functions.spec.ts`: register a JavaScript function through the UI, use a locator list whose first strategy is absent, run a loop with a condition and a counter, export, import into a fresh dir, replay → `passed`; no AI, no code outside the UI editor.

### F5: Agents and the improvement cycle

- **F5.1 MCP server.** `recnrun mcp` (stdio) as a thin adapter to the service; tools of source §15 (`capabilities.get`, `profiles.list`, `session.*`, `browser.inspect`, `browser.act`, `flow.*`, `run.*`, `issue.createReproducer`, `locators.*`, `functions.*`, `macros.extract`); structured, paginated results; `requestId` and lease on every mutation; errors with code, step, capability, retryability, evidence, alternative; stdout reserved for the protocol, logs to stderr.
  Accept: `tests/contract/mcp.test.ts` with a deterministic MCP client (`@modelcontextprotocol/sdk`): tool list matches the protocol, a full "create flow → add assertion → finalize → replay" scenario passes without any LLM, stdout carries only JSON-RPC.
- **F5.2 `recnrun agents setup`.** Targets `claude-code`, `codex`, `both`; project scope default, user scope optional; detect existing config, show the change, add without overwriting, keep a backup, `--undo`; MCP path points at the durable install, never the npx cache.
  Accept: `tests/contract/agents-setup.test.ts` in a temporary `HOME` and project: idempotent on a second run, existing servers and skills preserved, `--undo` restores the backup byte for byte.
- **F5.3 Skills.** `.agents/skills/recnrun-create-flow`, `recnrun-replay-flow`, `recnrun-investigate-run`, `recnrun-improve-tool`: short `SKILL.md`, references to schema and error codes, small examples, scripts for start/finalize/replay/inspect/reproducer that call the installed CLI. A criterion is never "satisfied by absence of error": each is `covered` with evidence or `not-covered`.
  Accept: `tests/contract/skills.test.ts`: frontmatter valid, every referenced script exists and runs against the Docker service producing the documented output; the packaged copy in the CLI equals the repository copy.
- **F5.4 Handoff.** Agent holds the lease, disconnects; capture continues; UI offers "take control"; the in-flight command is `indeterminate`; the journal keeps the last confirmed action.
  Accept: `tests/e2e/handoff.spec.ts`: drop the MCP client mid-click; events keep flowing; the UI takes control; no action is repeated (fixture counter).
- **F5.5 Reproducers.** `issue.createReproducer` writes `regressions/<issueId>/` (description, sanitized fixture or data, test skeleton, expected and observed, versions) that runs as a test.
  Accept: `tests/contract/reproducer.test.ts`: the generated folder is picked up by `vp run test:unit` and fails for the recorded reason.
- **F5.6 Improvement cycle, exercised.** Take one real engine defect found in F1 to F4A (there will be one; the checklist records which), preserve the run, classify, add the failing regression first, fix the right layer, validate the original scenario, document in `regressions/`.
  Accept: the regression's commit body shows `Red:` and `Green:`; the original flow passes.
- **F5.7 Built-in promotion with migration.** Opt-in migration tool compares original, custom, and built-in results; no flow changes silently.
  Accept: `packages/engine/tests/migration.test.ts`.

Gate F5: `tests/contract/mcp.test.ts` scenario green; `vp run verify` exits 0. Manual: M-F5.a, M-F5.b (real Claude Code and Codex sessions), M-F5.c (`codex exec --ephemeral -s read-only` loads the skills; run locally before merging F5.3).

### F6: Deep capture

- **F6.1 IndexedDB.** Hooks on request, cursor, transaction with commit/abort outcome; typed codecs for binary, Blob, Date, composite keys, structured clone; selective snapshots.
  Accept: `tests/browser/indexeddb.spec.ts` on the fixture's commit and abort routes; the equivalence test (fixture behaves identically with hooks on and off) passes.
- **F6.2 Workers and service workers.** Attach to dedicated and service worker targets; declare gaps for targets that were already running.
  Accept: `tests/browser/workers.spec.ts`.
- **F6.3 Cache Storage and cookies.** Inventory and diffs; HttpOnly cookies through CDP; never confused with HTTP cache.
  Accept: `tests/browser/cache-cookies.spec.ts`.
- **F6.4 Files and OPFS.** Metadata of accessible APIs; declared limits.
  Accept: `tests/browser/files.spec.ts`.
- **F6.5 Deep level and overhead.** Deep level toggle per scenario; bench extended; `docs/CAPABILITIES.md` regenerated.
  Accept: `tests/browser/bench-smoke.spec.ts` reports Deep numbers; the matrix has no `planned` row left for F6 surfaces.

Gate F6: `vp run verify` exits 0. The manual pilot (F7) does not wait for F6.

### F7: Distribution and pilot

- **F7.1 Package.** `apps/cli` builds `@recnrun/cli` with the service, built UI assets, MCP, and skills; `npm pack` in `verify`; `tests/distribution/clean-install.mjs` starts a clean `node:24` container with Google Chrome, installs the tarball with `npm exec`, runs `setup --non-interactive --data-dir <tmp>`, `doctor --json`, imports a fixture flow, and `run` → exit 0.
  Accept: `vp run test:distribution` passes in CI.
- **F7.2 Lifecycle.** `setup` idempotent (second run changes nothing, never restarts Chrome); optional launcher; durable install path; `uninstall` removes launcher and integrations and keeps flows unless `--purge-data`; update and rollback between two packed versions with data migration and backup; handshake rejects an older client with an update message.
  Accept: `tests/distribution/lifecycle.mjs`.
- **F7.3 Documentation and landing.** `README.md` install guide (Node LTS, Chrome, the `npx` commands, Chrome's confirmations described honestly); `apps/website` shows the same, no extension banner; `docs/RELEASE.md` (versioning, channels, changelog, what is manual).
  Accept: `vp run docs:check`; `tests/e2e/website.spec.ts` checks the landing copy and CSP.
- **F7.4 Release gate.** All manual items M-F1 to M-F7 recorded with date, machine, Chrome version, and result in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); then `npm publish` with authorization (M-F7.c).

Gate F7 (automated): `vp run verify` including `test:distribution` exits 0. Release: manual items done.

## 6. Security tests (cross-cutting, source §17 and §19)

Implemented in the phase that introduces the surface, listed here so none is forgotten:

| Threat                                    | Test                                                                            | Phase |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| Visited page controls the local API       | `tests/contract/service-auth.test.ts`                                           | F2.1  |
| Forged observer message from page content | `tests/browser/instrumentation.spec.ts`                                         | F1.4  |
| Captured HTML executes in the viewer      | `tests/e2e/viewer-sandbox.spec.ts`                                              | F3.3  |
| Zip path traversal, decompression bomb    | `tests/security/zip.test.ts`                                                    | F4.4  |
| Secret literal in export or YAML          | `tests/security/secrets.test.ts`                                                | F4.4  |
| Function import executes code             | `packages/engine/tests/registry.test.ts`                                        | F4A.2 |
| Blind retry of a write action             | `tests/browser/replay.spec.ts`                                                  | F2.5  |
| Egress to a non-loopback host             | every Docker test (`RECNRUN_FORBID_EGRESS`)                                     | F2.1  |
| Indiscriminate capture of personal tabs   | `tests/browser/scope.spec.ts`: tabs outside the session scope produce no events | F2.6  |

## 7. Working rules specific to this plan

- A task's red test fails for the behavior, not for a missing module; stubs reproduce today's behavior first.
- When a tool defect appears while implementing, follow source §16: preserve the run, classify, write the failing regression under `regressions/<issueId>/`, fix the layer, revalidate the original scenario. F5.6 only formalizes what every phase already does.
- Capability status moves only with a test that shows the new behavior and a regenerated `docs/CAPABILITIES.md`.
- Spike results are reported as "Google Chrome <version> on Linux in Docker" until a manual item confirms the same on Windows or macOS.
- Nothing is published and nothing is pushed to `master` without the owner's explicit authorization.

## 8. Assumptions, confirmed

The owner confirmed all five on 2026-11-02. They are decisions now; F0.1 acts on them.

1. `apps/extension` and `packages/bridge` are deleted in F0.1 (decision 2); history stays on `master` and in the archive tags.
2. `apps/website` stays as the public landing on GitHub Pages and gains the install guide.
3. Node 24 LTS is the official runtime; Node 22.18+ is tolerated.
4. Google Chrome Stable for Linux in Docker is the automated target; the default profile on Windows and macOS is validated manually.
5. The owner creates the npm scope `@recnrun` before F7.4.
