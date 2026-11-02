# Checklist

Tracks [PLAN.md](PLAN.md). One line per task; the orchestrator owns `[x]`, implementers own `[i]`.

## Resume protocol

1. Read [PLAN.md](PLAN.md) §2 to §5, this file, and the phase's ADRs and spike reports.
2. `git status` is clean and `git log --oneline -1` matches **Last commit** below; otherwise stop and report.
3. Take the first task of the current phase that is `[ ]`. Do not start a later phase while an earlier one has `[ ]` or `[!]` tasks, unless the owner says so.
4. Implement with red/green and one commit per task (see `.claude/agents/plan-implementer.md`). Mark `[i]` with indented `red:`, `green:`, and `commit:` lines.
5. When every task of the phase is `[i]`, the orchestrator asks Codex for a professional-level code review of the phase branch against its base, with the model `gpt-6.1-sol` at high reasoning (`codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high "<review prompt>"`). It evaluates every finding, applies the pertinent ones with red/green as further commits, and records the review under the phase as an indented `review:` line: findings accepted, findings declined and why.
6. A phase closes when the orchestrator runs `vp run verify` (exit 0), marks every task `[x]`, records the gate line, pushes the branch, and updates the pull request.
7. Manual items are tracked only in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md); never mark a task `[x]` on the strength of a manual check.

Markers: `[ ]` not started · `[i]` implemented, awaiting the phase gate · `[x]` verified by `vp run verify` · `[!]` blocked (reason indented) · `[~]` partial (what is missing indented).

**Branch:** `f0-contracts` holds F0 (closed) and `f1-spike` holds F1 (closed), each stacked on the previous; F2 starts on `f2-vertical`, branched from `f1-spike` (plan only on `local-engine-plan`; implementation branches are named after the phase)
**Last commit:** the branch tip whose subject is "Close phase F1 after the verify gate" (no hash: the commit cannot name itself)
**Current phase:** F2 (F1 closed on 2026-11-02; start with F2.1 on branch `f2-vertical`)

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

- [x] F1.1 Discovery (`DevToolsActivePort`, per-OS defaults)
  - red: `vp test --project=@recnrun/adapter` against a stub `discover()` that always answers `missing-file` (28 of 31 failed, for example `expected { ok: false, …(3) } to deeply equal { ok: true, …(5) }` and `expected 'Not implemented.' to match /chrome:\/\/inspect\/#remote-debuggin…/`); `vp run test:browser -- tests/browser/discover.spec.ts` against the same stub (2 of 2 failed, `expect(received).toEqual(expected)`); `vp test --project=@recnrun/protocol` before `schema:generate` (`discovery-result.schema.json is stale`) and before the matrix change (`chrome-discovery: expected 'planned' to be 'implemented'`); `vp run deps` before widening `adapter-boundaries` (`discovery.ts → fs/promises`, `net`, `os`, `path`); in a scratch worktree `node:child_process` and `node:http` still fail the widened rule
  - green: `vp test --project=@recnrun/adapter` (31 passed); `vp run test:browser -- tests/browser/discover.spec.ts` (2 passed on Google Chrome 156.0.8078.79 on Linux in Docker; the file stays after SIGKILL and reads as `stale-file`); `vp run test:unit` (240 passed); `vp run test:coverage` (96.67% statements, 88.26% branches; adapter 98.41%); `vp run test:browser` (23 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` (11/11) exit 0
  - commit: cb077ae
- [x] F1.2 Connection, handshake, loss, reconnection, contested control
  - red: `vp test --project=@recnrun/adapter` against stubs of `connect`, `rawCdpCall`, and the old adapter (26 failed, 29 passed; for example `Error: Connecting over CDP is not implemented yet.`, `TypeError: adapter.listTargets is not a function`); `vp run test:browser -- tests/browser/connect.spec.ts` in a scratch worktree against the `connect` stub (2 of 2 failed, `Error: Connecting over CDP is not implemented yet`) and with the preflight filter disabled (the contested test failed, expected one `control.contested` event, received `[]`); a scratch copy accepting any gap reason on `connection.lost` (`rejects a lost connection with another gap reason`: `expected true to be false`); the capability test before the matrix change (`cdp-connection: expected 'planned' to be 'implemented'`, `connection-loss-reconnect` and `contested-control` undefined); `vp run deps` before allowing Valibot (`raw-cdp.ts`, `handshake.ts` → `valibot`)
  - green: `vp run test:browser -- tests/browser/connect.spec.ts` (2 passed on Google Chrome 156.0.8078.79 on Linux in Docker: handshake with all eight domains available, `listTargets` shows a fixture page, SIGKILL → one `connection.lost` with its gap, `reconnect()` → `endpoint-gone` until `relaunch()`, then a second client attached to a page → `control.contested`, and its `Runtime.evaluate` still answers); `vp run test:unit` (280 passed); `vp run test:coverage` (94.67% statements, 86.45% branches, 91.93% functions, 96.14% lines); `vp run test:browser` (25 passed); `vp test --project=@recnrun/protocol` (154 passed); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` (11/11) exit 0. The gap is a journal gap payload; writing it to a run's `coverage.json` waits for runs (F3.5). Contested control is `partial`: DevTools opened after the connection gives CDP no signal (M-F1.d)
  - commit: 4ec53b1
  - note: the gap record is shaped for `coverage.json`, which no run writes before F3.5; F3.5 stores it as is. Contested control is `partial`: only a debugger attached before RECnRun connects is detected (M-F1.d updated).
- [x] F1.3 Profiles as bindings, two instances isolated
  - red: engine, persistence, adapter, and protocol unit tests against stubs (no detection, empty store, empty profile: 24 failed, for example `expected { status: 'fresh', … } to deeply equal { status: 'stale-restarted', … }`, `bindings-file.schema.json is stale`); `vp run test:browser -- tests/browser/profiles.spec.ts` against the stub store (`expected [] to equal ["Ana", "Bob"]`); scratch negatives: `classifyBinding` always fresh after a restart, every actor mapped to the first binding (`Expected: "Typed by b"`, `Received: ""`)
  - green: `vp run test:unit` (318 passed); `vp run test:browser` (26 passed on Google Chrome 156.0.8078.79 on Linux in Docker: A's localStorage and cookie absent in B, two-actor flow lands on the right instance, restart → `stale-restarted` reported and the stored binding unchanged, duplicate endpoint detected); `vp run test:coverage` (95.07% statements, 87.46% branches); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication`, `docs:check`, `vp run -r build` exit 0
  - commit: 20578f0 (cherry-picked from the agent worktree commit a3a74a9)
  - note: Chrome gives the default browser context a new id after a restart of the same profile, so `browserContextIds` are stored as observed values and never used to recognize a profile. Two profiles in one Chrome instance remain M-F1.c.
- [x] F1.4 Instrumentation installation order and message validation
  - red: `vp run test:browser -- tests/browser/instrumentation.spec.ts` with the install commands stubbed to resume only (5 failed: `hookSeenAtHead` `Expected: true, Received: false`, `dedicatedWorkers {observed: false}`); without the target-id check the forged-message spec counts `[1, 0]` instead of `[1, 1]`; with the hook keeping its first identity the popup spec reports url `about:blank` instead of `/routes/popup-child`; `capability-matrix.test.ts` → `instrumentation-order: expected 'planned' to be 'implemented'`
  - green: `vp run test:browser` (32 passed on Google Chrome 156.0.8078.79 on Linux in Docker; `instrumentation.spec.ts --repeat-each 30` → 150 passed); `vp run test:unit` (341 passed; 379 after the merge with F1.3); `vp run test:coverage` (95.74% statements, 89.06% branches, 93.07% functions, 96.83% lines); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication` (0 clones), `docs:check`, `vp run -r build` (11/11) exit 0
  - commit: a7366d3 (cherry-picked from the agent worktree commit 599e2f0)
  - note: `instrument()` runs on its own browser-level CDP socket beside `connect()`; wiring it into the adapter and the journal is F1.5. Chrome reuses a popup's `about:blank` context for its first same-origin document and releases a held popup on the first client's resume, so the hook is added with `runImmediately` and starts a new document identity lazily (on the first read of `window.__recnrunHook`); F1.5 messages must go through that path. Nothing is captured inside workers yet (`workers-deep` partial, F6.2); `frames-targets-normal` is partial until F1.5 captures inside frames. The extension service worker is instrumented as `late`; decide later whether to skip extension targets.
- [x] F1.5 Raw capture (DOM, network with bodies, console, errors)
  - red: `vp run test:browser -- tests/browser/capture.spec.ts` in a scratch worktree with capture switched off (7 failed: `expect(received).toBeDefined() Received: undefined` waiting for the hook install; body poll `Expected: 1 Received: 0`); with `input` removed from the hook's event list the golden test failed, missing its 8 input lines; `vp test --project=@recnrun/persistence` against a journal that does nothing (6 failed: `ENOENT … events.jsonl`, `promise resolved "undefined" instead of rejecting`); the new capability rows against the old matrix (5 failed, `expected 'planned' to be 'implemented'`); the schema drift test before `schema:generate`
  - green: `vp run test:browser -- tests/browser/capture.spec.ts` (7 passed on Google Chrome 156.0.8078.79 on Linux in Docker, stable over three runs); `vp run test:browser` (40 passed before F1.6 and F1.7 landed); on tip 8522bb6 `vp run test:unit` (526 passed), `vp run test:coverage` (533 passed; 96.4% statements, 90.8% branches, 93.3% functions, 97.55% lines); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication` (0 clones), `docs:check`, `vp run -r build` exit 0
  - commit: b027530
  - note: DOM events come through the hook (`HOOK_VERSION` 2, observer messages of kind `dom`); network (request with redirect chain, response, finished, failed, body), console, log, exceptions, navigations and target lifecycle become §11 envelope events, one producer per CDP session plus `cdp:browser`. The journal lives in persistence (`openJournal`/`readJournal`; a cut-off last line is dropped and reported as a `journal-truncated` gap); the adapter only hands events to `onEvent`. Bodies are read for Document, XHR and Fetch only (`not-requested` otherwise; `unavailable` with a reason when Chrome has none or the response is still loading at the deadline, as with `?fail=slow`); blobs are F3.1. `selectionchange` is captured but kept out of the golden file (Chrome coalesces it). `frames-targets-normal` stays partial: capture inside a same-origin iframe and a cross-site OOPIF is proven, but a failed install is still only on the instrumentation report, not a gap. Nothing inside workers (F6.2); console values are text at capture time; the opening dialog event has no `frameId`.
- [x] F1.6 Replay spike on the fixture
  - red: `vp test --project=@recnrun/engine --project=@recnrun/protocol` against a `runSteps` stub and an `isStepResult` stub (13 failed, for example `expected 'passed' to be 'error'`); `vp test --project=@recnrun/adapter` against a `createPageDriver` stub (14 failed, `got 'Replay is not implemented yet.'`); `vp run test:browser -- tests/browser/replay-spike.spec.ts` against the stubs (2 of 2 failed, `expect.poll` `Expected: true, Received: false`); in a scratch worktree, `fill` as `.value =` plus a dispatched `input` event (2 of 2 failed although every step passed: `untrusted` 1 instead of 0, `changes` 0 instead of 1); `capability-matrix.test.ts` before the matrix change (`replay-spike: expected 'planned' to be 'implemented'`)
  - green: `vp run test:browser -- tests/browser/replay-spike.spec.ts` (2 passed on Google Chrome 156.0.8078.79 on Linux in Docker; `--repeat-each 20` → 40 passed; counters `{"submits":1,"inputs":1,"changes":1,"clicks":1,"untrusted":0}`; with `?fail=status` steps 1 to 4 pass and `status` fails with `expected: "Submitted Ada Lovelace (…)"`, `observed: "Submitted nobody (…)"`); `vp run test:browser` (35 passed); `vp run test:unit` (409 passed); `vp run test:coverage` (95.8% statements, 90.49% branches); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication` (0 clones), `docs:check`, `vp run -r build` exit 0
  - commit: 2b6c72f (cherry-picked from the agent worktree commit f3dd93f)
  - note: a spike executor (`packages/engine/src/replay.ts` over four new `BrowserAdapter` methods); the F2.5 executor stays planned. The flow is `/routes/form` in place (the fixture's `?fail=status` lives there, not on `submit-result`). A step state has no `error`, so an exception is `failed` with an `error.code` other than `assertion-failed` and makes the run `error`; steps after a failure are omitted. Assertions read once; interpolation covers `${env|inputs|vars.<name>}` only; targets are a CSS string or a one-key shorthand; one replay tab per connection; Playwright's bound replaces per-step `timeoutMs`; the flow is canonical JSON (no `yaml` at the root). The fixture form counts trusted `input`/`change`/`click` and any untrusted event, which is what catches `.value =`.
- [x] F1.7 Custom locator function, element references, termination
  - red: `vp run test:browser -- tests/browser/function-locator.spec.ts` in a scratch worktree against a stub resolver (6 of 6 failed); scratch negatives: the function run in the main world (`status: "error"` instead of `matched` in the isolated-world test) and `Runtime.terminateExecution` not sent (`tabResponsive: false`, and 59.8 s because releases waited on the blocked renderer, which led to the bounded-release fix); `vp test --project=@recnrun/adapter tests/function-locator.test.ts` against stubs (22 of 26 failed) and before bounding releases (`Test timed out in 2000ms`); `vp test --project=@recnrun/protocol tests/function-locator.test.ts` against `v.never()` stubs (6 failed); `capability-matrix.test.ts` → `custom-locator-path: expected 'planned' to be 'implemented'`
  - green: `vp run test:browser -- tests/browser/function-locator.spec.ts --repeat-each 5` (30 passed on Google Chrome 156.0.8078.79 on Linux in Docker; `while (true) {}` with `timeoutMs: 500` → `deadline { blocked: true, terminated: true, tabResponsive: true }` after about 1.5 s, and the tab then fills a field and resolves again); `vp run test:unit` (415 passed); `vp run test:coverage` (96.12% statements, 89.82% branches); `vp check`, `vp lint --deny-warnings`, `deps`, `dead-code`, `duplication` (0 clones), `docs:check`, `vp run -r build`, `schema:generate`, `capabilities:generate` exit 0
  - commit: 8522bb6 (cherry-picked from the agent worktree commit c4e3bef)
  - note: `resolveFunctionLocator` is standalone (a session or an endpoint plus `targetId`); engine integration is F4A.1/F4A.3. At the deadline the tab is probed with `Runtime.evaluate` for up to 1 s and `terminateExecution` is sent only when it does not answer, so an idle tab awaiting a promise is never terminated and a cut loop returns after about `timeoutMs` + 1 s. References carry the frame's CDP `loaderId` as document identity, not the hook's `documentId`, which the isolated world cannot read. `many` with 0 elements is `not-found`; only `optional` accepts zero. Every handle release waits at most one probe timeout. The deadline covers the function call only; elements from another frame's document are `unsupported`.
- [x] F1.8 Spike report with versions, limits, estimates
  - red: `vp run docs:check` with the report written before its index (`docs/spikes/2026-11-f1-cdp-connection.md:3: broken link README.md: docs/spikes/README.md does not exist`)
  - green: `vp run docs:check` exits 0 with `docs/spikes/README.md`; `vp check` passes; every cited `tests/…` and `packages/…` path exists (20 of 20, `grep -o` + `test -e`) and every quoted test name appears in its test file (46 of 46); the pre-commit hook ran check, deps, and `test:unit` (526 passed)
  - commit: f71c9cf
  - note: no F1.8 matrix entry exists, so none was added. The report is linked from ARCHITECTURE.md (Adapter); PLAN.md has no link slot and is unchanged. Sizes for F2–F7 are relative (F4A XL; F2, F3, F4, F5 L; F6, F7 M). The automated F1 gate proves Linux only; the default profile on macOS and Windows, two profiles in one Chrome, and DevTools opened after connect stay M-F1.a–d.
- Gate F1: `vp run verify` → (date, result)
- review: Codex (`gpt-6.1-sol`, high) on `aeedb12...36cc8e1`, saved as [2026-11-f1-codex-review.md](../spikes/2026-11-f1-codex-review.md): 15 findings (4 High, 10 Medium, 1 Low), all accepted and fixed with red/green; none declined. High: composition events disclosed password text (bf2ebce); CDP endpoints were not checked for loopback before a socket opened (8f9ed70, `non-loopback-endpoint`); a failed partial journal write corrupted later appends (efde87b, the writer stays failed); result conversion of a function locator ran outside the deadline (3af8c2f, one deadline covers call, conversion, and description; reproduced with an array iterator or proxy, not the review's plain object). Medium: unbounded body reads left `settled()` hanging and `maxBodyLength` above the schema cap dropped bodies (ce6842b); concurrent bindings saves lost one (03e80a7); a second `connect()` abandoned the first (410dd19, `already-connected`); popup events kept the `about:blank` document id until something read the hook (60004fb, events held until the hook names the document, 2 s limit, fixture `popup-child-quiet`); actor isolation lived in the test while `runSteps` ignored `step.actor` (6adec64, `multi-actor-unsupported` until F4.3, capability note narrowed); `instrument()` leaked its channel when auto-attach failed (617fe9d); journal error paths leaked descriptors (003a028); a late locator result escaped release (608a2da); socket open had no deadline (e3ba13b). Low: workers were described as gaps (b0ba0ba, now `late`). After the fixes: unit 571, browser 49, coverage 96.58% statements, 90.88% branches
- Gate F1: `vp run verify` → 2026-11-02, exit 0 (33/33 tasks; unit 582, components 7, e2e 4, browser 50 on Google Chrome 156.0.8078.79 Linux in Docker; coverage 96.71% statements, 91.02% branches, 94.71% functions, 97.88% lines)
- Manual after gate: M-F1.a, M-F1.b, M-F1.c, M-F1.d

## F2: First vertical flow without AI

- [i] F2.1 Service: loopback, token, Origin/Host, lock, logs, drain
  - red: `vp test packages/protocol` (health shape) `expected false to be true`; `vp test packages/persistence` against stubs 10/12 failed (`expected { kind: 'absent' } to deeply equal { kind: 'invalid' }`); scratch-worktree negative controls on `vp test apps/service/tests tests/contract`: authorize-always-ok 5 failed (`expected 200 to be 401`/`403`), Origin unchecked 3 failed (`expected 101 to be 403`), no 4401 close timed out, live instance treated as stale 3 failed (`{ reused: false, port: 54451 }` vs `{ reused: true, port: 54450 }`), dead pid treated as starting 2 failed (`InstanceStartingError`), no drain `expected 16 to be 20000`, no forbidEgress `expected function to throw`, capability row `expected 'planned' to be 'implemented'`
  - green: in Docker `vp run test:unit` 51 files, 675 passed; `vp run test:contract` 2 files, 21 passed; `vp run test:coverage` 703 passed, thresholds met; `vp run test:container` 12 passed; check, lint `--deny-warnings`, deps, dead-code, duplication (0 clones), docs:check, `-r build` 11/11; after the cherry-pick onto the other F2 work: unit 942, contract 21
  - commit: 018885d (worktree f4630ef)
  - note: new `tests/contract` layer (`vp run test:contract`, `service-auth.test.ts` and `service-lifecycle.test.ts`, split by the 300-line cap; `vitest.config.ts` sets `RECNRUN_FORBID_EGRESS=1`). Alias decision: `apps/service/src` imports itself with `./` only, never `@/` or `../` (oxlint override in `vite.config.ts`), because the CLI and the contract tests compile service source under their own `@/`; the service's tests still use `@/`; recorded in ARCHITECTURE (Service → Imports) and AGENTS.md. HTTP `POST /api` only, checks in order Host/Origin → 403 `forbidden`, bearer header → 401 `unauthorized` with `WWW-Authenticate: Bearer`, 404/405/413 (1 MiB)/400; `invalid-request` → 400, `internal` → 500, other errors 200; unhandled commands answer `capability-unavailable`. WebSocket `/ws` hand-rolled RFC 6455 (no `ws`): bad Host/Origin → 403 before the handshake, bad or missing token → handshake then close 4401; `?token=` accepted on this path only. Lock stale when the pid is dead, the instance does not answer `capabilities.get` within 1 s, the file is invalid, or a live lock has no `service.json` after 10 s; a start gives up after 15 s (`InstanceStartingError`). `service.log` rotates at 1 MiB keeping 3 files, 0600, token never logged. SIGTERM drain test: 20,000 queued journal lines all present with contiguous seq. `forbidEgress()` patches `net.Socket.prototype.connect` under `RECNRUN_FORBID_EGRESS=1`. Health gained `pid`, `uptimeMs`, `chrome`. `service-boundaries` also allows `valibot`, `node:crypto`, `node:http`, `node:net`, `node:os`, `node:stream`. Contract tests point `HOME`, `CHROME_CONFIG_HOME`, and `LOCALAPPDATA` at a temp dir and assert `health.chrome.code === "missing-file"` (rule in `.claude/rules/tests.md`) after a host-side run hung on the owner's real Chrome (M-F1.a partial). Weak: `bin.ts` is 0% in coverage (runs only as a child process); logger and mask controls failed by unhandled error, not a clean assertion
- [i] F2.2 Sessions, control, leases, fencing, pause semantics
  - red: `vp run test:unit -- packages/engine/tests/{session,lease,pause}.test.ts packages/protocol/tests/{lease,api,states}.test.ts` against stubs of today's behavior: 74 failed (e.g. "idle on start goes to recording" got illegal-transition; `tick()` returned `[]` instead of the expired lease; `pauseStepCreation` left steps on; `LeaseSchema` accepted `fencingToken` 0); capability-matrix F2 row expected `implemented`, received `planned`
  - green: same command 198 passed; `vp run test:unit` 747 passed; `vp run test:coverage` 754 passed (engine/src 98.5% statements); check, lint `--deny-warnings`, deps, dead-code, duplication (0 clones), docs:check, `-r build` exit 0
  - commit: 76ec0ca (worktree 53fa2da)
  - note: transition tables in `packages/engine/src/machines.ts` (session, control, step, and one pause machine per mode), lease registry in `lease.ts` (`createLeaseRegistry({ now, ttlMs })`, injected time, `tick(now)` expires; lease id `<targetId>/<token>`, token starts at 1 and only grows per target; `acquire` on a held target is `lease-held`, `takeControl` succeeds at once over agent or replay, never over a person; `authorize` returns `stale-lease` with `currentFencingToken`), pauses in `session.ts` (a session is `paused` while any mode is paused; resuming `suspendCapture` returns a `capture-suspended` gap; a session stopped while capture is suspended leaves that gap for the service to close). Protocol: `RequestEnvelope.leaseToken` became `lease { leaseId, fencingToken }`, `SessionStatus` gained `pauses` and `lease`, `session.resume` requires `mode`, `PAUSE_MODES` moved to `states.ts`, new JSON Schema documents `lease` and `session-status`. Engine lease errors are TypeScript types; the service maps them to the protocol codes. Mutation check in a throwaway worktree: accepting older tokens failed 4 lease tests, one pause setting all modes failed 10 pause tests
- [i] F2.3 Normalization golden tests
  - red: `vp run test:unit` with `normalize` stubbed to `{ steps: [], excluded: [] }` and `suggestLocators` stubbed to a CSS tag: 20 failed (all 15 goldens with `expected { steps: [], excluded: [] } to deeply equal { steps: [ … ] }`, 4 locator tests, the input-order test); negative controls in a scratch worktree: with the mutation removed, "a mutated expectation fails the comparison" fails (`expected [Function] to throw an error`); with the redirect rule disabled, the redirect rule test fails
  - green: `vp run test:unit` 47 files, 643 passed; `vp run test:coverage` 96.95% statements, 91.04% branches, 95.45% functions, 98.04% lines (normalization/ 97.95/91.02/98.92/98.73); check, lint `--deny-warnings`, deps 6/6, dead-code, duplication (0 clones), docs:check, `-r build` 11/11 pass
  - commit: 14ad87b (worktree 4c2e98f)
  - note: `packages/engine/src/normalization/` (`normalize(events, options) → { steps, excluded }`, `suggestLocators`), protocol `suggestions.ts` (`SuggestedStep`, `ExcludedEvent`, `NormalizationResult`, JSON Schema `normalization-result`); 15 goldens in `packages/engine/tests/normalization/`: fill-grouping, fill-redacted (`${secrets.<name>}`, `redacted: true`), type-special-keys, type-autocomplete, navigate-after-click, scroll-dropped, scroll-kept, scroll-keep-option, dblclick, drag, shortcut, composition, overlay-excluded, replay-caused, actor-untrusted; `normalization-rules.test.ts` adds 9 edge cases. Interpretations: overlay detected by test id or id prefix `recnrun-overlay` (the hook reports no data attribute); role locators only with an `accessibleName` hint (capture does not record names yet); `dblclick` and `drag` are suggestion-only actions the editor must convert; `type` when a special key or shortcut precedes the last input or the value differs from the typed text; navigation cause = link or submit click, Enter, submit, or a previous navigate within 2000 ms; replay-caused = any `commandId` unless `replayCommandIds` narrows it; actor from `options.actors.producers` then bindings, never `isTrusted`; `excluded` lists only dropped events, absorbed ones sit in their step's `events`. Goldens load with `import.meta.glob` (engine tsconfig has no Node types). Not wired to live capture or the service yet
- [i] F2.4 Flow persistence, revisions, journal, SQLite index rebuild
  - red: `vp run deps` → `persistence-boundaries: packages/persistence/src/flow-yaml.ts -> node_modules/.pnpm/yaml@2.9.1/...` before the rule allowed `yaml`; `capability-matrix.test.ts` → `flow-persistence: expected 'planned' to be 'implemented'`; 12 negative controls in a scratch worktree (unsorted keys, folded YAML lines, revision overwritten by rename, no rebuild on open, a listing that rethrows on a corrupt manifest, a temp file left behind, the journal gap dropped, history overwritten, bad index rows not reported, index version ignored, folder id not checked, manifest history not checked) each failed exactly the matching test
  - green: `vp run test:unit` (Docker, Node v24.21.0) 47 files, 623 tests passed; `vp run test:coverage` exit 0 (96.5% statements, 90.5% branches, 95.6% functions, 97.7% lines); check, lint `--deny-warnings`, deps, dead-code, duplication (one 8-line clone, 0.14%), docs:check, `-r build` pass
  - commit: 506607a (worktree 34a2dd5)
  - note: `node:sqlite` needs no flag on Node 22.13+ (works in Docker on Node v24.21.0), so the index at `~/.recnrun/index.sqlite` is always on with no JSON fallback and a version in `PRAGMA user_version`; a missing or other-version index rebuilds on `openFlowStore`, otherwise writes keep rows in sync. Protocol `flow-folder.ts` (`FLOW_STATUSES`, `RevisionHashSchema`, `FlowManifestSchema`, `DatasetSchema`) and `stored-files.ts` (catalog rows, `FLOW_STORE_ERROR_CODES`, `parseStored`, `isId`); JSON Schema documents `flow-manifest` and `dataset`. `openFlowStore({ home, now? })`: `list` (with `problems` for skipped corrupt files), `get`, `saveFlow`, `listRevisions`, `getRevision`, `createRun`, `finishRun`, `listRuns`, plus `saveDataset`, `getDataset`, `getRun`, `rebuildIndex`, `close`. Canonical JSON sorts keys and drops `undefined`; revision = sha256; revision files hold the canonical bytes and are written with `link()`, so an existing file is never replaced; `manifest.json` keeps a `revisions` history for order; a save that changes nothing writes nothing; `flow.yaml` keeps schema field order; `requirements.md` is regenerated per save; a run without `summary.json` lists as `running` (interrupted marking is F3.6); run ids and dataset names are slugs. The persistence boundary now allows `yaml` (`.dependency-cruiser.cjs`, ARCHITECTURE). Not exercised: a real crash between temp write and rename (no fsync, same as the bindings store)
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
