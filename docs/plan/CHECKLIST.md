# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §2 to §5, this file, and the phase's ADRs and spike reports.
2. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so.
4. Implement with red/green and one commit per task (see `.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines.
5. A phase closes when the orchestrator runs `vp run verify` (exit 0), marks every task `[x]`, records the gate line, pushes the branch, and updates the pull request.
6. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `f0-contracts` holds F0 (closed); F1 starts on `f1-spike`, branched from it (plan only on `local-engine-plan`; implementation branches are named after the phase)
**Last commit:** the branch tip whose subject is "Close phase F0 after the verify gate" (no hash: the commit cannot name itself)
**Current phase:** F1 (F0 closed on 2026-11-02; start with F1.1 on branch `f1-spike`)

## F0: Contracts and skeleton

- [x] F0.1 ADRs, repository reshaping, `docs:check`
  - red: `vp run test:e2e -- tests/e2e/landing.spec.ts` on the old site (main showed the install banner, not "Chrome DevTools Protocol"); `node --test scripts/check-docs.checks.mjs` against an exit-0 stub (4 of 7 failed); `vp run test:coverage` after the deletion (lines 71.42%, statements 62.5%, branches 0%) and `mount.browser.test.tsx` against a no-op `mount` stub
  - green: `vp run test:e2e` (4 passed), `vp run test:components` (5 passed), `vp run test:coverage` (87.5% statements, 100% branches), `node --test scripts/check-docs.checks.mjs` (7 passed), `vp run docs:check` exits 0 on the branch and exits 1 on a broken link in a scratch worktree
  - commit: 96ea572 (delete the extension and bridge, landing), 7ca8326 (ADRs, docs, rules, skill), 62cd1c1 (`docs:check`), and the commit that adds this entry (testable `mount`, coverage)
- [x] F0.2 Workspace skeleton and dependency rules
  - red: in a scratch worktree with the workspaces but no boundary rules, `packages/engine` depending on and importing `playwright-core` passed `vp run deps`; with the rules it failed with `error engine-not-to-adapter-impl: packages/engine/src/index.ts → node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.d.ts`, and the fixture and ui negatives failed with `fixture-isolated` (`apps/fixture/src/index.ts → packages/protocol/src/index.ts`) and `ui-only-protocol` (`apps/ui/src/app/App.tsx → packages/engine/src/index.ts`); one negative each also tripped `protocol-pure`, `adapter-boundaries`, `persistence-boundaries`, `service-boundaries`, and `cli-only-service`. `vp run test:unit` against stub implementations failed 16 of 23; `vp run test:components` against a no-op ui `mount` failed 1 of 2 (`expected undefined to be 'RECnRun'`); a no-op default CLI writer failed `writes to standard output by default`
  - green: `vp run deps` (6 cruises, no violations), `vp run test:unit` (24 passed), `vp run test:components` (website 5, ui 2 passed), `vp run test:coverage` (91.42% statements, 100% branches, 100% functions, 90.62% lines), `vp check`, `vp lint --deny-warnings`, `vp run dead-code`, `vp run duplication` (0 clones), `vp run docs:check`, `vp run test:container` (10 passed), `vp run -r build` (11/11); `node apps/cli/src/bin.ts --version` prints `RECnRun protocol 1`
  - commit: the commit that adds this entry
- [x] F0.3 Protocol schemas v1 with JSON Schema drift test
  - red: `vp test --project=@recnrun/protocol` against accept-all stubs (64 of 91 failed, for example `expected [] to deeply equal [ [ 'unknown-action', … ] ]` per invalid fixture); drift in a scratch copy after adding a field to `FlowSchema` (`flow.schema.json is stale; run vp run schema:generate`); the `steps`/`otherwise` rename against the first commit (3 of 27 failed in `flow.test.ts`)
  - green: `vp test --project=@recnrun/protocol` (110 passed); `vp run test:unit` (128 passed in Docker); `vp run test:coverage` (protocol 99.57% statements, 89.23% branches); `vp lint --deny-warnings` (no warnings); `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` exit 0
  - commit: 72a0923, d47bd0e (cherry-picked from the agent worktree commits f7df0ba, c266235; the `if` block uses `steps`/`otherwise` because a `then` key makes a thenable)
- [x] F0.4 Capability matrix as code, `docs/CAPABILITIES.md` generated
  - red: `vp run docs:check` after editing one status in `docs/CAPABILITIES.md` (`docs/CAPABILITIES.md: stale; run vp run capabilities:generate`); `vp test --project=@recnrun/protocol` against an empty matrix (21 failed, `expected 0 to be greater than 0`); the fixture-app status test against the `planned` entry (`fixture-app: expected 'planned' to be 'implemented'`)
  - green: `vp run docs:check` exits 0; `vp test --project=@recnrun/protocol` (130 passed); `vp run test:scripts` (8 passed); `vp run test:unit` (203 passed in Docker); `vp run capabilities:generate` twice leaves the tree clean
  - commit: 273b9df (cherry-picked from the agent worktree commit 79218ab), cc7a8fd (fixture-app marked implemented once F0.5 landed)
- [x] F0.5 Fixture application
  - red: `vp run test:unit -- apps/fixture` against a stub server answering 404 (48 of 55 failed, `expected 404 to be 200`, `expected 404 to be 303`); `vp run test:browser -- tests/browser/fixture.spec.ts` against a stub index that never sets `window.__fixture` (19 of 19 failed, `page.waitForFunction: Timeout 10000ms exceeded`, `net::ERR_HTTP_RESPONSE_CODE_FAILURE` per route)
  - green: `vp run test:unit` (79 passed); `vp run test:browser` (21 passed on Google Chrome 156 in Docker); `vp run test:coverage` (fixture 93.65% statements, 84.54% branches); `test:container` (12 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` exit 0
  - commit: a425f3f (cherry-picked from the agent worktree commit 88d0288; second origin is `http://localhost:4601` so the iframe is cross-site, not only cross-origin)
- [x] F0.6 Google Chrome in Docker, `test:browser` layer
  - red: `vp run test:container` with the new checks before the Dockerfile change (`exec: "google-chrome": executable file not found in $PATH`, `versions.json` ENOENT, `manifest.scripts["test:browser"]` undefined); `vp run test:browser` against a stub fixture returning empty strings (`expect(lines).toHaveLength(2)` received `[""]`)
  - green: `vp run test:browser` (2 passed on Google Chrome 156.0.8078.79, Linux arm64, Docker); `vp run test:container` (12 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `test:hooks`, `test:scripts`, `test:e2e` (4 passed), `vp run -r build` exit 0
  - commit: 57a0ed2 (cherry-picked from the agent worktree commit acc95ce)
- Gate F0: `vp run verify` → 2026-11-02, exit 0 (33/33 tasks; unit 203, components 7, e2e 4, browser 21 on Google Chrome 156.0.8078.79 Linux in Docker; coverage 96.45% statements, 86.88% branches)

## F1: Connection and fidelity spike

- [i] F1.1 Discovery (`DevToolsActivePort`, per-OS defaults)
  - red: `vp test --project=@recnrun/adapter` against a stub `discover()` that always answers `missing-file` (28 of 31 failed, for example `expected { ok: false, …(3) } to deeply equal { ok: true, …(5) }` and `expected 'Not implemented.' to match /chrome:\/\/inspect\/#remote-debuggin…/`); `vp run test:browser -- tests/browser/discover.spec.ts` against the same stub (2 of 2 failed, `expect(received).toEqual(expected)`); `vp test --project=@recnrun/protocol` before `schema:generate` (`discovery-result.schema.json is stale`) and before the matrix change (`chrome-discovery: expected 'planned' to be 'implemented'`); `vp run deps` before widening `adapter-boundaries` (`discovery.ts → fs/promises`, `net`, `os`, `path`); in a scratch worktree `node:child_process` and `node:http` still fail the widened rule
  - green: `vp test --project=@recnrun/adapter` (31 passed); `vp run test:browser -- tests/browser/discover.spec.ts` (2 passed on Google Chrome 156.0.8078.79 on Linux in Docker; the file stays after SIGKILL and reads as `stale-file`); `vp run test:unit` (240 passed); `vp run test:coverage` (96.67% statements, 88.26% branches; adapter 98.41%); `vp run test:browser` (23 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` (11/11) exit 0
  - commit: cb077ae
- [i] F1.2 Connection, handshake, loss, reconnection, contested control
  - red: `vp test --project=@recnrun/adapter` against stubs of `connect`, `rawCdpCall`, and the old adapter (26 failed, 29 passed; for example `Error: Connecting over CDP is not implemented yet.`, `TypeError: adapter.listTargets is not a function`); `vp run test:browser -- tests/browser/connect.spec.ts` in a scratch worktree against the `connect` stub (2 of 2 failed, `Error: Connecting over CDP is not implemented yet`) and with the preflight filter disabled (the contested test failed, expected one `control.contested` event, received `[]`); a scratch copy accepting any gap reason on `connection.lost` (`rejects a lost connection with another gap reason`: `expected true to be false`); the capability test before the matrix change (`cdp-connection: expected 'planned' to be 'implemented'`, `connection-loss-reconnect` and `contested-control` undefined); `vp run deps` before allowing Valibot (`raw-cdp.ts`, `handshake.ts` → `valibot`)
  - green: `vp run test:browser -- tests/browser/connect.spec.ts` (2 passed on Google Chrome 156.0.8078.79 on Linux in Docker: handshake with all eight domains available, `listTargets` shows a fixture page, SIGKILL → one `connection.lost` with its gap, `reconnect()` → `endpoint-gone` until `relaunch()`, then a second client attached to a page → `control.contested`, and its `Runtime.evaluate` still answers); `vp run test:unit` (280 passed); `vp run test:coverage` (94.67% statements, 86.45% branches, 91.93% functions, 96.14% lines); `vp run test:browser` (25 passed); `vp test --project=@recnrun/protocol` (154 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` (11/11) exit 0. The gap is a journal gap payload; writing it to a run's `coverage.json` waits for runs (F3.5). Contested control is `partial`: DevTools opened after the connection gives CDP no signal (M-F1.d)
  - commit: 4ec53b1
  - note: the gap record is shaped for `coverage.json`, which no run writes before F3.5; F3.5 stores it as is. Contested control is `partial`: only a debugger attached before RECnRun connects is detected (M-F1.d updated).
- [i] F1.3 Profiles as bindings, two instances isolated
  - red: engine, persistence, adapter, and protocol unit tests against stubs (no detection, empty store, empty profile: 24 failed, for example `expected { status: 'fresh', … } to deeply equal { status: 'stale-restarted', … }`, `bindings-file.schema.json is stale`); `vp run test:browser -- tests/browser/profiles.spec.ts` against the stub store (`expected [] to equal ["Ana", "Bob"]`); scratch negatives: `classifyBinding` always fresh after a restart, every actor mapped to the first binding (`Expected: "Typed by b"`, `Received: ""`)
  - green: `vp run test:unit` (318 passed); `vp run test:browser` (26 passed on Google Chrome 156.0.8078.79 on Linux in Docker: A's localStorage and cookie absent in B, two-actor flow lands on the right instance, restart → `stale-restarted` reported and the stored binding unchanged, duplicate endpoint detected); `vp run test:coverage` (95.07% statements, 87.46% branches); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` exit 0
  - commit: 20578f0 (cherry-picked from the agent worktree commit a3a74a9)
  - note: Chrome gives the default browser context a new id after a restart of the same profile, so `browserContextIds` are stored as observed values and never used to recognize a profile. Two profiles in one Chrome instance remain M-F1.c.
- [ ] F1.4 Instrumentation installation order and message validation
- [ ] F1.5 Raw capture (DOM, network with bodies, console, errors)
- [ ] F1.6 Replay spike on the fixture
- [ ] F1.7 Custom locator function, element references, termination
- [ ] F1.8 Spike report with versions, limits, estimates
- Gate F1: `vp run verify` → (date, result)
- Manual after gate: M-F1.a, M-F1.b, M-F1.c, M-F1.d

## F2: First vertical flow without AI

- [ ] F2.1 Service: loopback, token, Origin/Host, lock, logs, drain
- [ ] F2.2 Sessions, control, leases, fencing, pause semantics
- [ ] F2.3 Normalization golden tests
- [ ] F2.4 Flow persistence, revisions, journal, SQLite index rebuild
- [ ] F2.5 Replay executor: actions, assertions, extraction, no blind retry
- [ ] F2.6 Minimal UI and `first-flow.spec.ts`
- [ ] F2.7 CLI `open`, `run`, `doctor`
- Gate F2: `vp run verify` → (date, result)
- Manual after gate: M-F2.a

## F3: Diagnostics and robust persistence

- [ ] F3.1 Network evidence, blobs, conditions, redaction
- [ ] F3.2 Console and errors
- [ ] F3.3 Snapshots, screenshots, sandboxed viewer
- [ ] F3.4 Storage, normal level
- [ ] F3.5 Coverage and loss accounting
- [ ] F3.6 Crash recovery
- [ ] F3.7 Diagnostics UI and run comparison
- [ ] F3.8 `run.compare`, `run.queryEvents`
- [ ] F3.9 Overhead benchmark and bounded memory
- Gate F3: `vp run verify` → (date, result)
- Manual after gate: M-F3.a

## F4: Editor, parameters, multiple profiles, import/export

- [ ] F4.1 Full editor and revisions
- [ ] F4.2 Inputs, datasets, preconditions, variables
- [ ] F4.3 Actors and bindings, A-B-A on two instances
- [ ] F4.4 Export and import with security tests
- [ ] F4.5 Flow status and requirement coverage
- [ ] F4.6 Initial state and scoped reset
- Gate F4: `vp run verify` → (date, result)
- Manual after gate: M-F4.a

## F4A: Locator lists, function registry, macros

- [ ] F4A.1 Locator resolution policies and trace
- [ ] F4A.2 Function registry and lockfile
- [ ] F4A.3 Function runtimes and cancellation
- [ ] F4A.4 Macro runtime built-ins and limits
- [ ] F4A.5 Macro SDK
- [ ] F4A.6 UI: locator editor, function catalog, JS editor, blocks, extract macro
- [ ] F4A.7 Function export and import
- [ ] F4A.8 Promotion to built-in, exercised once
- Gate F4A: `vp run verify` → (date, result)

## F5: Agents and the improvement cycle

- [ ] F5.1 MCP server and deterministic client scenario
- [ ] F5.2 `recnrun agents setup`
- [ ] F5.3 Four skills with scripts
- [ ] F5.4 Handoff
- [ ] F5.5 Reproducers
- [ ] F5.6 Improvement cycle exercised on a real defect (issue: …)
- [ ] F5.7 Built-in promotion with opt-in migration
- Gate F5: `vp run verify` → (date, result)
- Manual after gate: M-F5.a, M-F5.b, M-F5.c

## F6: Deep capture

- [ ] F6.1 IndexedDB
- [ ] F6.2 Workers and service workers
- [ ] F6.3 Cache Storage and cookies
- [ ] F6.4 Files and OPFS
- [ ] F6.5 Deep level and overhead
- Gate F6: `vp run verify` → (date, result)

## F7: Distribution and pilot

- [ ] F7.1 Package and clean install in a container
- [ ] F7.2 Lifecycle: setup, uninstall, update, rollback, handshake
- [ ] F7.3 Documentation and landing
- [ ] F7.4 Release gate (manual items recorded, publish authorized)
- Gate F7: `vp run verify` → (date, result)
- Manual before release: M-F7.a, M-F7.b, M-F7.c
