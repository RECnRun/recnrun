# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §2 to §6, this file, the capability file (`CAPABILITIES.md`, once P0.4 exists), and the experiment reports of the current phase.
2. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so. P2 to P6 wait for the owner's route decision recorded under P1.8.
4. Implement with red/green and one commit per task (see `.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines. An experiment task also records its verdicts (`verdict:` line, one per hypothesis).
5. A phase closes when the orchestrator runs `vp run verify` (exit 0), runs `vp run test:stress` when the phase owns an `@order-critical` scenario, obtains the Codex review (step 6), marks every task `[x]`, records the gate lines, pushes the branch, and updates the pull request.
6. **Codex review before a phase closes.** The orchestrator asks Codex for a professional-level code review of the phase's commits, with the model `gpt-6.1-sol` at high reasoning effort: `codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` with a prompt that names the commit range, the plan task IDs, and the repository rules (`AGENTS.md`). The orchestrator evaluates every finding, applies the changes it considers pertinent with red/green and one commit per change, rejects the rest with a reason, saves the review's full text as `reviews/P<n>.md` (absolute paths turned into relative links), and records the outcome in the gate's `review:` line (date, findings, applied, rejected with reasons). A review that was not run blocks the gate.
7. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.
8. Changing the fixture after P0.6 requires a new `freeze.json`, a line under P0.6 saying what changed and why, and the owner's agreement (the application under test must not learn to cooperate).

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `poc-namespace-sessions` (from `master` at `8a7f97b`)
**Last commit:** the branch tip whose subject is "Close phase P0 of the namespaced sessions POC" (no hash: the commit cannot name itself)
**Current phase:** P1 (start with P1.1)
**Route decision (P1.8):** pending

## P0: Audit, harness, and capability map

- [x] P0.1 Plan documents and `docs:check`
  - red: `node --test scripts/check-docs.checks.mjs` against a stub `check-docs.mjs` (no checks, identity slug): 4 of 7 failed (missing file, missing anchor, slug, checks array)
  - green: `node --test scripts/check-docs.checks.mjs` 7 passed; `vp run docs:check` exits 0; a scratch worktree with a broken link and anchor exits 1
  - commit: "Check that every relative Markdown link and anchor resolves" 049a482 on the branch
- [x] P0.2 Google Chrome Stable in Docker and the browser layer
  - red: `vp run test:browser` (image without Chrome) -> 2 failed, "Google Chrome was not found. Install Google Chrome Stable, set RECNRUN_CHROME_PATH ..."; `vp run test:container` -> `exec: "google-chrome": executable file not found in $PATH`, versions.json ENOENT
  - green: `vp run test:browser` -> 2 passed, product `Chrome/156.0.8078.79` (Google Chrome 156.0.8078.79 on Linux in Docker); `vp run test:container` -> 12 passed; `vp run test:experiments` -> exit 0 (`--pass-with-no-tests`); `vp run test:e2e` -> 8 passed
  - commit: a0ecbf1 "Run Google Chrome Stable in Docker behind browser and experiment layers"
- [x] P0.3 Load the unpacked extension into branded Chrome (E0), report [experiments/E0.md](experiments/E0.md)
  - red: `vp test --project=@recnrun/isolator` with `startBackground` stubbed -> 4 failed (`expected { isolatorLoaded: undefined } to deeply equal ...`); `vp run test:experiments -- tests/experiments/E0-load-extension.spec.ts` with the loaders stubbed to `unavailable` -> "at least one method produced a sampled verdict ... Expected: > 0 Received: 0"; `vp run test:browser -- tests/browser/extension.spec.ts` with the same stub -> "Google Chrome 156.0.8078.79 accepted no extension-loading method; ..."; `node --test tests/container/runner.checks.mjs` before the evidence export -> 3 failed (4 directory copies expected, 3 made); scratch worktree with forbidden imports -> `isolator-only-poc-packages`, `isolator-not-to-recording-apps`, `nothing-to-isolator` errors
  - green: `vp test --project=@recnrun/isolator` 4 passed; `vp run test:experiments` 5 passed, `capabilities.json` `extensionLoad.method: cdp-load-unpacked`, `--repeat-each=10` same verdicts 10 of 10; `vp run test:browser` 4 passed (loaded with `cdp-load-unpacked`); `node --test tests/container/runner.checks.mjs` 12 passed; `vp run test:e2e` 8 passed; `vp check`, `vp run deps`, `vp run dead-code`, `vp run duplication`, `vp run docs:check`, `vp run test:unit` (pre-commit) pass
  - verdict: (a) pass, Google Chrome 156.0.8078.79 on Linux in Docker: `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging` over the port and over `--remote-debugging-pipe` (with `--remote-debugging-port=0` alongside); control without the flag also passes
  - verdict: (b) pass with `DeveloperToolsAvailability: 1`; with default policies the CRX3 force-installs but `Target.attachToTarget: Not allowed`
  - verdict: (c) pass, `diagnostic` (Google Chrome for Testing 156.0.8078.4 with `--load-extension`); not needed
  - commit: f04b421 "Add the isolator extension workspace for the namespaced sessions POC"; d5541f7 "Load the isolator into Google Chrome and record experiment E0"
- [x] P0.4 `chrome.debugger` capability probe (E1), [CAPABILITIES.md](CAPABILITIES.md) generated, report [experiments/E1.md](experiments/E1.md)
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
  - commit: 5f437da "Probe chrome.debugger capabilities from the isolator in E1"
- [x] P0.5 SplitSession vendoring and license
  - red: `vp test --project=@recnrun/isolation-core` before the manifest existed: `Error: ENOENT: no such file or directory, open '.../vendor/splitsession/vendor-manifest.json'`; negative controls: a changed byte in `namespace.ts` and a LICENSE without "MIT License" each failed their test
  - green: `vp test --project=@recnrun/isolation-core` (15 passed after trimming the vendor set to 11 runtime files); `vp check`, `vp run deps` pass; jscpd 0.20% (threshold 4%); Knip passes with `ignoreDependencies: ["wxt"]` scoped to the isolation-core workspace (the vendored `cookie-capture.ts` names upstream's runtime framework; P3 adapts it inside `apps/isolator`)
  - commit: the commit adding `packages/isolation-core` ("Vendor SplitSession modules into a new isolation-core package") and "Keep only the reusable SplitSession modules in the vendor set"
  - note: vendor set excludes upstream tests, fixtures, `dnr-simulator.ts`, and `legacy/`; Knip treats `vendor/splitsession/src/**/*.ts` as entries until P2
- [x] P0.6 Fixture application, frozen
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
- [x] P0.7 Evidence pipeline and observer allowlist
  - red: `vp test --project=harness` with `redact()` as identity: 7 of 11 failed (`expected 'http://x.localhost/?api_sid=tok-en&b=1' to be 'http://x.localhost/?api_sid=sha256:50…'`); `vp run test:browser -- tests/browser/fixture.spec.ts -g 'serves storage'` in a scratch worktree with redaction disabled: `a raw cookie value in .../trace.jsonl` `Expected: false` `Received: true`
  - red: `vp run test:unit` in a scratch worktree with `tests/browser/scratch.spec.ts` calling `chrome.cdp.send("Fetch.enable")` under `chromeArgs: ["--disable-back-forward-cache"]`: `expected [ …(2) ] to deeply equal []` with `scratch.spec.ts:3 --disable-back-forward-cache: --disable-back-forward-cache is forbidden by decision 5` and `scratch.spec.ts:6 Fetch.enable: Fetch.enable is forbidden by decision 5`
  - red: `vp run test:unit` in a scratch worktree whose background fetches `https://example.com` after recording the marker: `expected [ 'https://example.com', …(1) ] to deeply equal []`; with `nativeMessaging` and `externally_connectable` in the scratch `wxt.config.ts`: `wxt.config.ts: expected { Object (name, description, ...) } to not have property "externally_connectable"`
  - green: `vp run test:unit` 118 passed (harness: `redaction.test.ts` 11, `observer-allowlist.test.ts` 6; isolator: `egress.test.ts` 3); `vp run test:browser` 7 passed, each `fixture.spec.ts` test writes `.artifacts/evidence/<run>/fixture/<test>/{trace.jsonl,ledger.json,storage.json,counters.json}` with no raw `api_sid`/`idp_sid` value and their hashes present (Google Chrome 156.0.8078.79 on Linux in Docker)
  - commit: 7c75f83 "Record redacted evidence from a CDP observer in browser tests"; 3630eb4 "Fail the suite when the harness sends a forbidden CDP command or flag"; 67eaa48 "Check that the isolator background reaches only the loopback" (agent worktree SHAs)
  - note: evidence lives per test at `.artifacts/evidence/<run>/<spec>/<test>/`, since one spec has several tests; Chrome answers IndexedDB, Cache Storage, and Web Storage reads only for origins with a frame in the observed page, so `storage.json` records Chrome's error for the others
- Gate P0: `vp run verify` → 2026-11-02, exit 0 (36/36 tasks; coverage 95.68% statements, 87.56% branches, 96.44% functions, 97.3% lines; Google Chrome 156.0.8078.79 on Linux in Docker); no `@order-critical` scenario in P0, so no `vp run test:stress`
  - review: Codex `gpt-6.1-sol` high, 2026-11-02, over `master..5f437da`; full text in [reviews/P0.md](reviews/P0.md). 7 findings (5 major, 2 minor), 7 applied, 0 rejected. Applied: (1) probes whose accepted command had no effect now record `rejected`, and every sample's detail is kept, 52f0b27; (2) the allowlist rejects `addScriptTag`, `addStyleTag`, `setContent`, and any `Browser.setPermission` that does not say `setting: "denied"`, 1aac860; (3) the CDP client rejects pending commands when the transport closes and after a 30 s deadline, 116d5f9; (4) E1 verdicts and capabilities carry the load `method` and the `diagnostic` label, rendered in CAPABILITIES.md, 1b336f2; (5) the fixture ledger is reset once per test and the saved `ledger.json` holds every variant, 7eabba3; (6) applied as a loopback check on every probe target before any debugger call plus the probe entrypoint under the egress guard (the reviewer's wider "non-loopback iframe must fail before Chrome receives it" case is covered by that check), edce945; (7) `docs:check` validates same-document anchors, 226b406. Each fix has its own red/green in its commit body; `vp run verify` reran after the fixes (the result above).

## P1: Minimal service-worker proof

- [i] P1.1 Route A: tab attach and auto-attach before `register()` (E2)
  - red: `vp test --project=@recnrun/isolation-core --project=@recnrun/worker-bootstrap` against identity stubs of `installMarker`, `markUrl`, `physicalName` -> 14 failed ("is one classic script that patches the realm's first fetch, database, and cache": the URL without `__rec`, no `__rec:e2-m1:` prefix); `vp test --project=@recnrun/isolator tests/route-a.test.ts` against a stub `RouteAEngine` -> 11 of 12 failed (`expected [] to deeply equal [ 'Runtime.evaluate', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger' ]`); with the release awaiting the bootstrap's reply -> "releases a service worker that answers the bootstrap only once released" received `[ "Runtime.evaluate: no reply within 5000 ms", undefined, true ]`; `vp test --project=harness tests/e2-samples.test.ts` against a stub evaluation -> 8 of 9 failed (`expected [] to deeply equal [ 'firstEffectBeforeMarker' ]`); `vp run test:experiments -- tests/experiments/E2-route-a-register.spec.ts` with the same stub -> `Expected: "number" Received: "undefined"`
  - green: the same commands pass 38, 13, and 9 tests; `vp test --project=@recnrun/isolator` 50 passed; `vp run test:experiments -- tests/experiments/E2-route-a-register.spec.ts` 1 passed in runs A `2026-11-02T21-07-38.129Z-3ec346fc` (140 loads in 14.9 s) and C `2026-11-02T21-14-21.179Z-11a25df3` (20.7 s); `vp run test:experiments` 7 passed (run B `2026-11-02T21-12-16.403Z-3cda1144`)
  - verdict: Google Chrome 156.0.8078.79 on Linux in Docker, `cdp-load-unpacked`, runs A, B, C; report [experiments/E2.md](experiments/E2.md)
  - verdict: `service-worker-register` fail: 100, 99, and 100 of 100 first effect before the marker (`Cache Storage holds fixture-sw without the prefix` in 299 of 300; the bootstrap after the top-level script, first request and `fixture-sw` database plain, in 4 of 300; 1 sample passed); every service worker attached waiting, bootstrapped, and released; `bootstrapMs` p50 7.1 to 12.9, p95 9.7 to 28.5, max 12.3 to 52.2
  - verdict: `dedicated-worker` fail: 10 of 10 first effect before the marker in each run (`Cache Storage holds fixture-dedicated without the prefix (10)`); requests and IndexedDB marked in 30 of 30; `bootstrapMs` p50 1.9 to 4.1, max 3.7 to 6.6
  - verdict: `shared-worker` fail: 10 of 10 first effect before the marker in each run, `notAttached` 10 (`no Target.attachedToTarget for /shared-worker.js?type=classic (5)`, the same for `module`)
  - verdict: `nested-worker` unavailable: `the frozen fixture starts no worker from a worker (apps/fixture/public/app/worker.js, shared-worker.js)`
  - commit: "Build the marker bootstrap into one script for worker evaluation" c960507; "Bootstrap auto-attached workers before release in the isolator" 404c31d; "Release a paused worker without waiting for its bootstrap reply" 2ec68f8; "Record experiment E2 on Route A bootstraps before register" b42b95f
- [ ] P1.2 Route A: direct worker target, cold start, the race (E3) `@order-critical`
  - note: the stress runner exists (`scripts/test-stress.mjs`): `vp run test:stress` in Docker (`-- --iterations N` or `RECNRUN_STRESS_ITERATIONS`; default 100), `vp run test:stress:local` on the host; it runs the tests whose title ends with `@order-critical` and writes `.artifacts/evidence/<run>/stress.json`
- [ ] P1.3 Stop and restart control (E4)
- [ ] P1.4 Route B: script response transformation through `Fetch` (E5)
- [ ] P1.5 Route B: namespace selection without baking it into the script (E6) `@order-critical`
- [i] P1.6 Route C: composition for pages and non-service workers (E7)
  - red: `vp test --project=@recnrun/isolator` before Route C -> 31 failed (`expected 'constructed' to be 'SecurityError: RECnRun Route C refuse…'`, `expected [ 'storage', 'management', 'debugger' ] to include 'scripting'`, `ENOENT ... public/ns/slot-0.js`, `expected undefined to be an instance of RouteCEngine`); `vp test --project=harness tests/e7-samples.test.ts` against a stub evaluation -> 17 failed (`expected [] to deeply equal [ 'unpatched', …(2) ]`); the `data:` attribution case, the `noReport` and `storeMissing` texts, and the frame's message text -> 1 failed each; `vp run test:experiments -- tests/experiments/E7-route-c-pages-workers.spec.ts` with `summarize()` returning no counts, in a scratch worktree -> `Error: page`, `Expected: "number" Received: "undefined"` (run `2026-11-03T08-05-27.215Z-06ee6f75`)
  - green: `vp test --project=@recnrun/isolator` 81 passed; `vp test --project=harness` 59 passed; `vp run test:experiments -- tests/experiments/E7-route-c-pages-workers.spec.ts` 1 passed in run A `2026-11-03T07-52-10.527Z-35435d5b` (4.4 min); `vp run test:experiments` 8 passed, E2 unchanged after the shared `page-loads.ts` (run B `2026-11-03T07-59-15.543Z-d4158286`)
  - verdict: Google Chrome 156.0.8078.79 on Linux in Docker, `cdp-load-unpacked`, runs A and B with the same counts; report [experiments/E7.md](experiments/E7.md)
  - verdict: `page` pass: 40 of 40 (`/`, `/storage.html`), the marker before the first script 40 of 40
  - verdict: `cross-site-iframe` pass: 10 of 10; registered for the app only, unmarked 5 of 5; registered with the IdP, marked before the first script 5 of 5
  - verdict: `popup` pass: 10 of 10, the opener's message 10 of 10; registered with the IdP, marked 5 of 5
  - verdict: `dedicated-worker` and `shared-worker` fail, 60 of 60 each: `fail-closed` failed closed 20 of 20 (`SecurityError: RECnRun Route C refused new Worker(/worker.js?type=classic): no wrapper keeps the worker's own self.location, baseURI, and relative imports`); `blob` bootstrapped first but `self.location is a blob: URL` 20 of 20; `data` bootstrapped first in an opaque origin (`Origin: null`), `the page got no report` and no store on the app origin 20 of 20; `unpatched` 0
  - verdict: `shared-worker-identity` fail: one instance per two-tab pair with native constructors 3 of 3 and `data` 3 of 3, two instances with `blob` 3 of 3
  - verdict: `same-origin-iframe`, `about-blank-child`, `sandboxed-frame` unavailable: `the frozen fixture (apps/fixture/public) has no …` (so `matchOriginAsFallback` is registered but not exercised)
  - commit: "Add Route C, a MAIN-world page bootstrap, to the isolator" 35be78e; "Record experiment E7 on Route C for pages, frames, and workers" 430cb0e; "Name the renew message when E7's iframe parent gets none" 9d18ec7
  - note: the owner decides whether any worker wrapper is acceptable; the default refuses workers, which keeps the invariant but leaves no worker usable under Route C
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
