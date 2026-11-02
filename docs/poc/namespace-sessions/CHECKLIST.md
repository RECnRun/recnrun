# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §2 to §6, this file, the capability file (`CAPABILITIES.md`, once P0.4 exists), and the experiment reports of the current phase.
2. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so. P2 to P6 wait for the owner's route decision recorded under P1.8.
4. Implement with red/green and one commit per task (see `.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines. An experiment task also records its verdicts (`verdict:` line, one per hypothesis).
5. A phase closes when the orchestrator runs `vp run verify` (exit 0), runs `vp run test:stress` when the phase owns an `@order-critical` scenario, marks every task `[x]`, records both gate lines, pushes the branch, and updates the pull request.
6. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.
7. Changing the fixture after P0.6 requires a new `freeze.json`, a line under P0.6 saying what changed and why, and the owner's agreement (the application under test must not learn to cooperate).

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `poc-namespace-sessions` (from `master` at `8a7f97b`)
**Last commit:** the branch tip whose subject is "Add the plan for the namespaced sessions POC" (no hash: the commit cannot name itself)
**Current phase:** P0 (start with P0.1)
**Route decision (P1.8):** pending

## P0: Audit, harness, and capability map

- [i] P0.1 Plan documents and `docs:check`
  - red: `node --test scripts/check-docs.checks.mjs` against a stub `check-docs.mjs` (no checks, identity slug): 4 of 7 failed (missing file, missing anchor, slug, checks array)
  - green: `node --test scripts/check-docs.checks.mjs` 7 passed; `vp run docs:check` exits 0; a scratch worktree with a broken link and anchor exits 1
  - commit: "Check that every relative Markdown link and anchor resolves" 049a482 on the branch
- [i] P0.2 Google Chrome Stable in Docker and the browser layer
  - red: `vp run test:browser` (image without Chrome) -> 2 failed, "Google Chrome was not found. Install Google Chrome Stable, set RECNRUN_CHROME_PATH ..."; `vp run test:container` -> `exec: "google-chrome": executable file not found in $PATH`, versions.json ENOENT
  - green: `vp run test:browser` -> 2 passed, product `Chrome/156.0.8078.79` (Google Chrome 156.0.8078.79 on Linux in Docker); `vp run test:container` -> 12 passed; `vp run test:experiments` -> exit 0 (`--pass-with-no-tests`); `vp run test:e2e` -> 8 passed
  - commit: a0ecbf1 (1f21735 in the agent worktree) "Run Google Chrome Stable in Docker behind browser and experiment layers"
- [ ] P0.3 Load the unpacked extension into branded Chrome (E0)
- [ ] P0.4 `chrome.debugger` capability probe (E1), `CAPABILITIES.md` generated
- [ ] P0.5 SplitSession vendoring and license
- [ ] P0.6 Fixture application, frozen
- [ ] P0.7 Evidence pipeline and observer allowlist
- Gate P0: `vp run verify` → (date, result)

## P1: Minimal service-worker proof

- [ ] P1.1 Route A: tab attach and auto-attach before `register()` (E2)
- [ ] P1.2 Route A: direct worker target, cold start, the race (E3) `@order-critical`
- [ ] P1.3 Stop and restart control (E4)
- [ ] P1.4 Route B: script response transformation through `Fetch` (E5)
- [ ] P1.5 Route B: namespace selection without baking it into the script (E6) `@order-critical`
- [ ] P1.6 Route C: composition for pages and non-service workers (E7)
- [ ] P1.7 Original-session filter and prefix collision
- [ ] P1.8 P1 report and decision point
- Gate P1: `vp run verify` → (date, result); `vp run test:stress` (E3, E6) → (date, iterations, late attaches)
- Manual after gate: M-P1.a
- Owner's route decision: (date, route per capability)

## P2: Namespace core

- [ ] P2.1 Model and schemas
- [ ] P2.2 Storage
- [ ] P2.3 IndexedDB
- [ ] P2.4 Cache Storage
- [ ] P2.5 Cookies facade
- [ ] P2.6 BroadcastChannel and Web Locks
- [ ] P2.7 WebSocket and EventSource
- [ ] P2.8 Worker realms
- [ ] P2.9 OPFS, Storage Buckets, inventory
- Gate P2: `vp run verify` → (date, result)

## P3: Cookies and network without staging

- [ ] P3.1 Jars
- [ ] P3.2 Managed tabs: isolation before the first request `@order-critical`
- [ ] P3.3 Two mechanisms, one test set
- [ ] P3.4 Requests without a `tabId`
- [ ] P3.5 Late responses `@order-critical`
- [ ] P3.6 HTTP cache and `Vary`
- [ ] P3.7 Ports and same-name cookies
- Gate P3: `vp run verify` → (date, result); `vp run test:stress` (P3.2, P3.5) → (date, iterations, leaks)

## P4: The switch transaction

- [ ] P4.1 State machine and journal
- [ ] P4.2 Admission barrier and drain
- [ ] P4.3 Park and reload clients `@order-critical`
- [ ] P4.4 Exclusivity of the original session
- [ ] P4.5 Workers across the switch
- [ ] P4.6 Negative control: plain reload
- [ ] P4.7 Reset of a suspended session
- [ ] P4.8 A → B → A → C → A end to end `@order-critical`
- Gate P4: `vp run verify` → (date, result); `vp run test:stress` (P4.3, P4.8) → (date, iterations, leaks)
- Manual after gate: M-P4.a

## P5: Automatic discovery

- [ ] P5.1 Evidence graph
- [ ] P5.2 Unknown dependencies first met in a worker
- [ ] P5.3 Redirects, popups, silent renew, cross-origin API, subdomains, ports
- [ ] P5.4 Shared resources across environments
- Gate P5: `vp run verify` → (date, result)

## P6: Compatibility

- [ ] P6.1 Offline and cache hits `@order-critical`
- [ ] P6.2 Service worker lifecycle `@order-critical`
- [ ] P6.3 Background events
- [ ] P6.4 Failures
- [ ] P6.5 Volume and pressure
- [ ] P6.6 Expired sessions and extra APIs
- [ ] P6.7 Framework lab
- Gate P6: `vp run verify` → (date, result); `vp run test:stress` (P6.1, P6.2) → (date, iterations, leaks)
- Manual after gate: M-P6.a, M-P6.b

## P7: Packaging

- [ ] P7.1 Package and manifest guard
- [ ] P7.2 UI
- [ ] P7.3 T23, automated part
- [ ] P7.4 Uninstall and data
- Gate P7: `vp run verify` → (date, result)
- Manual after gate: M-P7.a, M-P7.b, M-P7.c, M-P7.d

## P8: Final report and decision

- [ ] P8.1 Decision script
- [ ] P8.2 Report
- Gate P8: `vp run verify` → (date, result); decision printed by `scripts/decide.mjs` → (GO | GO partial | NO-GO)
- Manual before the report is final: every item of [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md) has a recorded result or an explicit "not run" with the reason
