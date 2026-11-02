# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §2 to §6, this file, the capability file (`CAPABILITIES.md`, once P0.4 exists), and the experiment reports of the current phase.
2. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so. P2 to P6 wait for the owner's route decision recorded under P1.8.
4. Implement with red/green and one commit per task (see `.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines. An experiment task also records its verdicts (`verdict:` line, one per hypothesis).
5. A phase closes when the orchestrator runs `vp run verify` (exit 0), runs `vp run test:stress` when the phase owns an `@order-critical` scenario, obtains the Codex review (step 6), marks every task `[x]`, records the gate lines, pushes the branch, and updates the pull request.
6. **Codex review before a phase closes.** The orchestrator asks Codex for a professional-level code review of the phase's commits, with the model `gpt-6.1-sol` at high reasoning effort: `codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` with a prompt that names the commit range, the plan task IDs, and the repository rules (`AGENTS.md`). The orchestrator evaluates every finding, applies the changes it considers pertinent with red/green and one commit per change, rejects the rest with a reason, and records the outcome in the gate's `review:` line (date, findings, applied, rejected with reasons). A review that was not run blocks the gate.
7. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.
8. Changing the fixture after P0.6 requires a new `freeze.json`, a line under P0.6 saying what changed and why, and the owner's agreement (the application under test must not learn to cooperate).

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
- [i] P0.3 Load the unpacked extension into branded Chrome (E0), report [experiments/E0.md](experiments/E0.md)
  - red: `vp test --project=@recnrun/isolator` with `startBackground` stubbed -> 4 failed (`expected { isolatorLoaded: undefined } to deeply equal ...`); `vp run test:experiments -- tests/experiments/E0-load-extension.spec.ts` with the loaders stubbed to `unavailable` -> "at least one method produced a sampled verdict ... Expected: > 0 Received: 0"; `vp run test:browser -- tests/browser/extension.spec.ts` with the same stub -> "Google Chrome 156.0.8078.79 accepted no extension-loading method; ..."; `node --test tests/container/runner.checks.mjs` before the evidence export -> 3 failed (4 directory copies expected, 3 made); scratch worktree with forbidden imports -> `isolator-only-poc-packages`, `isolator-not-to-recording-apps`, `nothing-to-isolator` errors
  - green: `vp test --project=@recnrun/isolator` 4 passed; `vp run test:experiments` 5 passed, `capabilities.json` `extensionLoad.method: cdp-load-unpacked`, `--repeat-each=10` same verdicts 10 of 10; `vp run test:browser` 4 passed (loaded with `cdp-load-unpacked`); `node --test tests/container/runner.checks.mjs` 12 passed; `vp run test:e2e` 8 passed; `vp check`, `vp run deps`, `vp run dead-code`, `vp run duplication`, `vp run docs:check`, `vp run test:unit` (pre-commit) pass
  - verdict: (a) pass, Google Chrome 156.0.8078.79 on Linux in Docker: `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging` over the port and over `--remote-debugging-pipe` (with `--remote-debugging-port=0` alongside); control without the flag also passes
  - verdict: (b) pass with `DeveloperToolsAvailability: 1`; with default policies the CRX3 force-installs but `Target.attachToTarget: Not allowed`
  - verdict: (c) pass, `diagnostic` (Google Chrome for Testing 156.0.8078.4 with `--load-extension`); not needed
  - commit: 7e8bc5a "Add the isolator extension workspace for the namespaced sessions POC"; f527d34 "Load the isolator into Google Chrome and record experiment E0" (agent worktree SHAs)
- [i] P0.4 `chrome.debugger` capability probe (E1), [CAPABILITIES.md](CAPABILITIES.md) generated, report [experiments/E1.md](experiments/E1.md)
  - red: `vp test --project=@recnrun/isolator` with `runProbes` stubbed to return `[]` -> 5 failed (`expected [] to deeply equal [ 'get-targets', …(28) ]`, `attach-service-worker: expected undefined to match object { status: 'unavailable' }`); with `tabHeight` missing -> `TypeError: harness.tabHeight is not a function`; `vp run test:experiments -- tests/experiments/E1-debugger-capabilities.spec.ts` with the same stub -> "every probe ran" received only `infobar-hidden`; `node --test scripts/check-docs.checks.mjs` before wiring -> `reports a CAPABILITIES.md that no longer matches its capabilities.json` (`actual code: 0, expected code: 1`); scratch worktree with a hand-edited `CAPABILITIES.md` -> `node scripts/check-docs.mjs` exit 1, `CAPABILITIES.md:1: stale; run ...`; scratch worktree without `--silent-debugger-extension-api` -> `infobar-hidden` rejected 3 of 3, `tab height 1333 -> 1277`
  - green: `vp test --project=@recnrun/isolator` 11 passed; `vp run test:experiments` 6 passed (E1 29 probes plus the infobar, 3 samples each, identical); `vp run test:scripts` 13 passed; `vp run docs:check` exit 0; `vp run test:unit` 105 passed; `vp run test:browser` 7 passed; `vp run test:container` 12 passed; `vp run test:coverage` 114 passed (probes 96% statements, 88% branches); `vp check`, `vp run deps`, `vp run dead-code`, `vp run duplication` (0.21%) pass
  - verdict: Google Chrome 156.0.8078.79 on Linux in Docker, permissions `storage`, `management`, `debugger`, no host permissions
  - verdict: `getTargets()` pass: service worker and shared worker typed `worker`, dedicated worker `other`; `attach({ targetId })` pass for all three
  - verdict: `attach({ tabId })` + `Target.setAutoAttach` pass for the dedicated worker (`worker`), the running service worker (`service_worker`, not waiting), and a cross-site iframe (`iframe`, waiting, empty URL); `Runtime.runIfWaitingForDebugger` releases them; shared worker fail: `no Target.attachedToTarget for the shared-worker`
  - verdict: `Target.getTargets` and `Target.attachToTarget` from a tab session fail: `{"code":-32000,"message":"Not allowed"}`
  - verdict: `ServiceWorker.enable` fails on the tab and the service worker session: `{"code":-32601,"message":"'ServiceWorker.enable' wasn't found"}`
  - verdict: pass on the tab session: `Fetch.enable` with worker-script patterns, `Storage.getCookies`, `Network.setCookie`, `Network.enable`, `Page.addScriptToEvaluateOnNewDocument`
  - verdict: pass on the service worker session: `Runtime.evaluate`, `Fetch.enable`, `Debugger.pause` (paused event arrives), `Target.closeTarget` (worker leaves `getTargets()`); `Runtime.terminateExecution` on the dedicated worker fails: `{"code":-32000,"message":"Runtime.terminateExecution is not allowed for untrusted clients"}`
  - verdict: infobar hidden with `--silent-debugger-extension-api` pass (tab height unchanged, no new `chrome://` target; the control without the flag shrinks it by 56 px)
  - commit: the commit whose subject is "Probe chrome.debugger capabilities from the isolator in E1"
- [i] P0.5 SplitSession vendoring and license
  - red: `vp test --project=@recnrun/isolation-core` before the manifest existed: `Error: ENOENT: no such file or directory, open '.../vendor/splitsession/vendor-manifest.json'`; negative controls: a changed byte in `namespace.ts` and a LICENSE without "MIT License" each failed their test
  - green: `vp test --project=@recnrun/isolation-core` (15 passed after trimming the vendor set to 11 runtime files); `vp check`, `vp run deps` pass; jscpd 0.20% (threshold 4%); Knip passes with `ignoreDependencies: ["wxt"]` scoped to the isolation-core workspace (the vendored `cookie-capture.ts` names upstream's runtime framework; P3 adapts it inside `apps/isolator`)
  - commit: the commit adding `packages/isolation-core` ("Vendor SplitSession modules into a new isolation-core package") and "Keep only the reusable SplitSession modules in the vendor set"
  - note: vendor set excludes upstream tests, fixtures, `dnr-simulator.ts`, and `legacy/`; Knip treats `vendor/splitsession/src/**/*.ts` as entries until P2
- [i] P0.6 Fixture application, frozen
  - red: `vp run test:unit` exit 1, 21 fixture tests failed against a stub that answers 404 with no `freeze.json` (`expected 404 to be 400`, `No Location header on http://127.0.0.1:39743/login (404)`, `expected { …(2) } to deeply equal {}`)
  - green: `vp run test:unit` exit 0, 72 passed (fixture: `server.test.ts` 21, `freeze.test.ts` 2)
  - commit: the commit whose subject is "Add the frozen fixture application for the sessions POC"
  - red: `vp test --project fixture` with the new `tests/control.test.ts`: 6 failed (`expected { error: 'Not found' } to deeply equal { mode: 'online' }`, `expected 200 to be 'network error'`, `expected 404 to be 400`, the open EventSource still streaming after the cut)
  - green: `vp run test:unit` exit 0, 94 passed (fixture: `server.test.ts` 21, `control.test.ts` 7, `freeze.test.ts` 2)
  - commit: "Let the fixture server cut the network and expire sessions"
  - refreeze (orchestrator decision, before the freeze is final): added `POST /__network?mode=offline|online` (P6.1, the fixture-side network cut) and `POST /__expire?user=` (P6.6, T21) so no later phase refreezes; `freeze.json` changed only for `src/api.ts`, `src/context.ts`, `src/server.ts`, `src/sessions.ts`; no file under `public/` changed
  - red: `node <scratch worktree>/scripts/test-container.mjs test:browser:local -- tests/browser/fixture.spec.ts` with the worker-before-first-paint assertion inverted: `Error: /worker.js?type=classic before workers:first-paint` `Expected: > 38` `Received: 35`
  - green: `vp run test:browser -- tests/browser/fixture.spec.ts` 3 passed (also with `--repeat-each=4`, 12 passed); `vp run test:browser` 5 passed; `vp run test:container` 12 passed (Google Chrome 156.0.8078.79 on Linux in Docker)
  - commit: "Open every fixture route in Google Chrome from the browser layer"
  - note: Chrome facts recorded by the spec and the README: push subscription is `NotAllowedError` without the notification permission (headed Chrome otherwise waits on the prompt, so the spec denies it through CDP), and a dynamic `import()` in a service worker is a `TypeError` by design
- [i] P0.7 Evidence pipeline and observer allowlist
  - red: `vp test --project=harness` with `redact()` as identity: 7 of 11 failed (`expected 'http://x.localhost/?api_sid=tok-en&b=1' to be 'http://x.localhost/?api_sid=sha256:50…'`); `vp run test:browser -- tests/browser/fixture.spec.ts -g 'serves storage'` in a scratch worktree with redaction disabled: `a raw cookie value in .../trace.jsonl` `Expected: false` `Received: true`
  - red: `vp run test:unit` in a scratch worktree with `tests/browser/scratch.spec.ts` calling `chrome.cdp.send("Fetch.enable")` under `chromeArgs: ["--disable-back-forward-cache"]`: `expected [ …(2) ] to deeply equal []` with `scratch.spec.ts:3 --disable-back-forward-cache: --disable-back-forward-cache is forbidden by decision 5` and `scratch.spec.ts:6 Fetch.enable: Fetch.enable is forbidden by decision 5`
  - red: `vp run test:unit` in a scratch worktree whose background fetches `https://example.com` after recording the marker: `expected [ 'https://example.com', …(1) ] to deeply equal []`; with `nativeMessaging` and `externally_connectable` in the scratch `wxt.config.ts`: `wxt.config.ts: expected { Object (name, description, ...) } to not have property "externally_connectable"`
  - green: `vp run test:unit` 118 passed (harness: `redaction.test.ts` 11, `observer-allowlist.test.ts` 6; isolator: `egress.test.ts` 3); `vp run test:browser` 7 passed, each `fixture.spec.ts` test writes `.artifacts/evidence/<run>/fixture/<test>/{trace.jsonl,ledger.json,storage.json,counters.json}` with no raw `api_sid`/`idp_sid` value and their hashes present (Google Chrome 156.0.8078.79 on Linux in Docker)
  - commit: cf6b2c7 "Record redacted evidence from a CDP observer in browser tests"; be41738 "Fail the suite when the harness sends a forbidden CDP command or flag"; "Check that the isolator background reaches only the loopback" (agent worktree SHAs)
  - note: evidence lives per test at `.artifacts/evidence/<run>/<spec>/<test>/`, since one spec has several tests; Chrome answers IndexedDB, Cache Storage, and Web Storage reads only for origins with a frame in the observed page, so `storage.json` records Chrome's error for the others
- Gate P0: `vp run verify` → (date, result); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)

## P1: Minimal service-worker proof

- [ ] P1.1 Route A: tab attach and auto-attach before `register()` (E2)
- [ ] P1.2 Route A: direct worker target, cold start, the race (E3) `@order-critical`
- [ ] P1.3 Stop and restart control (E4)
- [ ] P1.4 Route B: script response transformation through `Fetch` (E5)
- [ ] P1.5 Route B: namespace selection without baking it into the script (E6) `@order-critical`
- [ ] P1.6 Route C: composition for pages and non-service workers (E7)
- [ ] P1.7 Original-session filter and prefix collision
- [ ] P1.8 P1 report and decision point
- Gate P1: `vp run verify` → (date, result); `vp run test:stress` (E3, E6) → (date, iterations, late attaches); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)
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
- Gate P2: `vp run verify` → (date, result); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)

## P3: Cookies and network without staging

- [ ] P3.1 Jars
- [ ] P3.2 Managed tabs: isolation before the first request `@order-critical`
- [ ] P3.3 Two mechanisms, one test set
- [ ] P3.4 Requests without a `tabId`
- [ ] P3.5 Late responses `@order-critical`
- [ ] P3.6 HTTP cache and `Vary`
- [ ] P3.7 Ports and same-name cookies
- Gate P3: `vp run verify` → (date, result); `vp run test:stress` (P3.2, P3.5) → (date, iterations, leaks); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)

## P4: The switch transaction

- [ ] P4.1 State machine and journal
- [ ] P4.2 Admission barrier and drain
- [ ] P4.3 Park and reload clients `@order-critical`
- [ ] P4.4 Exclusivity of the original session
- [ ] P4.5 Workers across the switch
- [ ] P4.6 Negative control: plain reload
- [ ] P4.7 Reset of a suspended session
- [ ] P4.8 A → B → A → C → A end to end `@order-critical`
- Gate P4: `vp run verify` → (date, result); `vp run test:stress` (P4.3, P4.8) → (date, iterations, leaks); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)
- Manual after gate: M-P4.a

## P5: Automatic discovery

- [ ] P5.1 Evidence graph
- [ ] P5.2 Unknown dependencies first met in a worker
- [ ] P5.3 Redirects, popups, silent renew, cross-origin API, subdomains, ports
- [ ] P5.4 Shared resources across environments
- Gate P5: `vp run verify` → (date, result); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)

## P6: Compatibility

- [ ] P6.1 Offline and cache hits `@order-critical`
- [ ] P6.2 Service worker lifecycle `@order-critical`
- [ ] P6.3 Background events
- [ ] P6.4 Failures
- [ ] P6.5 Volume and pressure
- [ ] P6.6 Expired sessions and extra APIs
- [ ] P6.7 Framework lab
- Gate P6: `vp run verify` → (date, result); `vp run test:stress` (P6.1, P6.2) → (date, iterations, leaks); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)
- Manual after gate: M-P6.a, M-P6.b

## P7: Packaging

- [ ] P7.1 Package and manifest guard
- [ ] P7.2 UI
- [ ] P7.3 T23, automated part
- [ ] P7.4 Uninstall and data
- Gate P7: `vp run verify` → (date, result); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)
- Manual after gate: M-P7.a, M-P7.b, M-P7.c, M-P7.d

## P8: Final report and decision

- [ ] P8.1 Decision script
- [ ] P8.2 Report
- Gate P8: `vp run verify` → (date, result); decision printed by `scripts/decide.mjs` → (GO | GO partial | NO-GO); `review:` Codex `gpt-6.1-sol` high → (date, findings, applied, rejected)
- Manual before the report is final: every item of [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md) has a recorded result or an explicit "not run" with the reason
