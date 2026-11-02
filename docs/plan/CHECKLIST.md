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

**Branch:** `local-engine-plan` (plan only; implementation branches are named after the phase, `f0-contracts`, `f1-spike`, …)
**Last commit:** the branch tip whose subject is "Add the phased plan for the local engine over CDP" (no hash: the commit cannot name itself)
**Current phase:** F0 (assumptions of PLAN.md §8 confirmed by the owner on 2026-11-02; start with F0.1 on branch `f0-contracts`)

## F0: Contracts and skeleton

- [i] F0.1 ADRs, repository reshaping, `docs:check`
  - red: `vp run test:e2e -- tests/e2e/landing.spec.ts` on the old site (main showed the install banner, not "Chrome DevTools Protocol"); `node --test scripts/check-docs.checks.mjs` against an exit-0 stub (4 of 7 failed); `vp run test:coverage` after the deletion (lines 71.42%, statements 62.5%, branches 0%) and `mount.browser.test.tsx` against a no-op `mount` stub
  - green: `vp run test:e2e` (4 passed), `vp run test:components` (5 passed), `vp run test:coverage` (87.5% statements, 100% branches), `node --test scripts/check-docs.checks.mjs` (7 passed), `vp run docs:check` exits 0 on the branch and exits 1 on a broken link in a scratch worktree
  - commit: 96ea572 (delete the extension and bridge, landing), 7ca8326 (ADRs, docs, rules, skill), 62cd1c1 (`docs:check`), and the commit that adds this entry (testable `mount`, coverage)
- [ ] F0.2 Workspace skeleton and dependency rules
- [ ] F0.3 Protocol schemas v1 with JSON Schema drift test
- [ ] F0.4 Capability matrix as code, `docs/CAPABILITIES.md` generated
- [ ] F0.5 Fixture application
- [ ] F0.6 Google Chrome in Docker, `test:browser` layer
- Gate F0: `vp run verify` → (date, result)

## F1: Connection and fidelity spike

- [ ] F1.1 Discovery (`DevToolsActivePort`, per-OS defaults)
- [ ] F1.2 Connection, handshake, loss, reconnection, contested control
- [ ] F1.3 Profiles as bindings, two instances isolated
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
