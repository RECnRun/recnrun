# POC: namespaced sessions with working service workers

Plan date: 2026-11-02. Source: the Portuguese POC plan written with ChatGPT on 2026-11-02 (revision 2), kept in [source-2026-11-02.pt-BR.md](source-2026-11-02.pt-BR.md) ("the source"), verbatim apart from the table whitespace the repository's formatter adds. This document turns it into phases, tasks, and acceptance criteria that a test command can check with nobody at the keyboard. Everything that needs a person is in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md) and runs after the automated gates. Progress is tracked in [CHECKLIST.md](CHECKLIST.md).

The repository rules ([AGENTS.md](../../../AGENTS.md)) apply to every task: red/green tests, one commit per task, exercise each change, `vp run verify` exits 0 before a phase closes.

## 1. The question and the constraints

Can one Chrome profile, at the same URLs, switch between users A → B → A → C → A quickly, keeping each user's authentication and local data in permanent namespaces, with service workers working, without touching the application, and with nothing but an MV3 extension at runtime? (source §1)

The twelve requirements of source §2 are restated here as the checks that enforce them. A requirement with no automated check is a manual item, never an assumption.

| Req | Summary                                                                                     | Enforced by                                                                                                   |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1  | The target application is never edited                                                      | P0.6 freezes the fixture's build hashes; `fixture-freeze.test.ts` fails on any change after the freeze        |
| R2  | Instrumentation may be injected; a response transformed in transit is declared and measured | P1.4, P1.5 record `transformed: true` in the capability file; the report never says "identical bytes"         |
| R3  | No dump, restore, staging, or copy of storage per switch                                    | `copy-counter` in the evidence of every switch test must be 0 bytes (P4.1); the T20 volume test (P6.5)        |
| R4  | Service workers stay enabled; fetch interception and offline are real                       | T09 (P6.1), T04 (P2.8); a registration refused or unregistered as policy fails `sw-policy.test.ts`            |
| R5  | No manual list of API, SSO, or domains                                                      | P5: the fixture's SSO and API hosts are never named in the extension's source (`no-host-list.test.ts`)        |
| R6  | The original session cannot stay active elsewhere while B is active                         | T13 (P4.4), including iframes, popups, PWA windows, hidden clients                                            |
| R7  | A new execution per switch; no renaming of live handles                                     | T06 (P4.5): old handles fail closed, new document reads the new namespace                                     |
| R8  | A late response of A never counts for B; no automatic replay of side effects                | T05 (P3.5), the server ledger of the fixture                                                                  |
| R9  | Profiles, browser contexts, and per-user subdomains are controls only                       | Control runs are labelled `control` in the evidence; the decision script ignores them for GO (P8.1)           |
| R10 | Branded Google Chrome is the validation target                                              | P0.2 and P0.3: every browser test runs on Google Chrome Stable in Docker; Chromium runs are labelled          |
| R11 | All runtime in the extension; no companion, host, local server, proxy, CA, external CDP     | P0.7 observer allowlist: the harness may only inspect; `egress.test.ts`; the manifest guard (P7.1)            |
| R12 | Build, fixture, and runner are development-only                                             | P7.3 automated part of T23 (harness without CDP commands to application targets); strict T23 is manual M-P7.a |

Nothing in this plan claims isolation against hostile code or native browser isolation (source §2, last paragraph).

## 2. Decisions

1. **Branch and base.** This POC lives on `poc-namespace-sessions`, branched from `master` at `8a7f97b`, where the WXT MV3 extension toolchain, the Docker runner, and the hooks still exist. It is independent of the local-engine line (`local-engine-plan`, `f0-contracts`, `f1-spike`), which retired the extension. Its outcome is a report and a decision, not a merge into `master`.
2. **One extension, four workspaces.** The runtime is `apps/isolator` (WXT, MV3). Pure code that must also run inside pages and workers lives in `packages/isolation-core` (namespaces, patches, handshake, schemas); the bootstrap bundle for workers is built by `packages/worker-bootstrap`; the controllable target is `apps/fixture`. The existing `apps/extension`, `packages/domain`, and `packages/bridge` stay untouched: they are the recording product's M0 skeleton, not this POC.
3. **Google Chrome Stable in Docker is the automated target.** `Dockerfile.tests` installs Google Chrome Stable for Linux next to the Playwright image (ported from the local-engine branch, commit `57a0ed2`); tests launch it headed on Xvfb with a throwaway `--user-data-dir`. Chromium and Chrome for Testing are diagnostic only and every result on them is labelled `diagnostic` in the evidence.
4. **Loading the extension into branded Chrome is itself an experiment (P0.3).** Chrome 137 removed `--load-extension` from branded builds; Playwright's documentation says to use Chromium instead. The candidates are the CDP `Extensions.loadUnpacked` command with `--enable-unsafe-extension-debugging` (what Puppeteer's `installExtension` does) and a managed policy `ExtensionSettings` force-install from a loopback update server. If neither works on the installed version, P0.3 records it, the browser layer runs on Chromium as `diagnostic`, and M-P0.a carries the branded proof.
5. **The harness observes; it never provides capability.** Tests drive pages with Playwright and inspect physical state through a CDP observer (`IndexedDB`, `CacheStorage`, `Storage`, `Network.getCookies`). An allowlist test (P0.7) fails the suite if any test file sends a CDP command that pauses, instruments, blocks, or rewrites (`ServiceWorker.*`, `Fetch.*`, `Debugger.*`, `Target.setAutoAttach`, `Page.addScriptToEvaluateOnNewDocument`, `Network.setCookie`, `Storage.clear*`, `Emulation.*`). Chrome launch flags are limited to profile location, `--no-first-run`, `--no-sandbox` (Docker root), `--silent-debugger-extension-api` (hides the infobar; it adds no capability), and the flag P0.3 needs to load the extension. `--disable-back-forward-cache` is forbidden: T14 needs the real cache.
6. **Experiments are falsifiable tests with recorded verdicts.** A hypothesis task (P0.3, P0.4, P1.x) is accepted when its spec runs every listed hypothesis and writes a verdict (`pass`, `fail`, `unavailable`, with the error text, Chrome version, and sample counts) to `.artifacts/evidence/<run>/verdicts.json`. A failed hypothesis does not fail the task; a hypothesis that did not run does. The decision in P8 is computed from the verdicts by a script, not written by hand.
7. **Evidence is a file set, not a console.** Every browser test writes `.artifacts/evidence/<run>/`: CDP event trace from the observer, the fixture's server ledger (user, operation, sequence per request), the physical storage inventory (database and cache names per origin), the extension's exported log, and counters (bytes copied, rules installed, switch timings). Tests assert on these files; tokens and cookie values are hashed before they are written (P0.7).
8. **Stress is automated but separate.** `vp run test:stress` repeats the order-critical specs 100 times with varied network delay, CPU load, warm/cold worker, and switch moment, in Docker. It is not part of `verify` (too slow) but a phase that owns an order-critical scenario does not close until the checklist records a stress run with zero leaks (source §12).
9. **Reusing SplitSession.** The modules of source §3 are vendored at commit `475afe88cd1ec7208b2a5510759036955032e0d4` (MIT) under `packages/isolation-core/vendor/splitsession/`, with the license and a manifest of file hashes checked by a test. Later upstream commits are recorded, never silently pulled.
10. **Earlier RECnRun POCs are inputs.** Section 3 lists what the tab-group containers, single-tab, and origin-snapshot POCs (branches `poc/tab-group-containers`, `poc/single-tab-multi-user`, `poc/origin-snapshot`) already measured. Their failed hypotheses are not repeated as hypotheses; their working mechanisms are reused.

## 3. Inherited evidence

Measured on Playwright Chromium or Chrome for Testing 156 (never branded Chrome), macOS and Docker, October 2026. Each line gives the implication for this plan.

- **DNR + `webRequest` alone cannot follow a cookie change through a redirect.** After a login or logout `302`, the next request left with the old jar in 49 and 50 of 50 runs (tab-group POC, variant N1). `Fetch` interception through `chrome.debugger` with an extension-owned jar (variant N2B1) was right 20 of 20. P3.3 compares the two again on the same tests, as the source asks, but the expectation is set and the plan does not depend on DNR for first-request correctness.
- **A synchronous XHR to a DNR-redirected marker URL selects an identity in ~3.3 ms without the debugger** (variant B2). Dedicated and shared workers can do the same; service workers cannot issue synchronous XHR, so P1.5 tests `importScripts` of an extension URL as the service-worker analogue.
- **`chrome.scripting.executeScript` with `injectImmediately` is too late** for a bootstrap (0 of 20). Bootstraps use `content_scripts` at `document_start` in the MAIN world, `Page.addScriptToEvaluateOnNewDocument`, or `Runtime.evaluate` on a target paused by `waitForDebuggerOnStart`.
- **Service workers were disabled in the earlier containers** (`register` rejected with `SecurityError`), and a shared worker's requests escaped the jar because `Fetch` never paused them. This POC must do what those POCs declared out of scope; P1 and P3.4 own it.
- **The HTTP cache leaked another identity's response** until a `cache-control: no-cache` request header was added on matched hosts; a `no-store` response header did not help. T17 (P3.6) starts from that fact.
- **`Set-Cookie` must be attributed to the document that made the request** (CDP `loaderId`, `webNavigation` `documentId`), never to the tab's current identity, and requests from unknown documents were failed closed. P3.5 reuses this.
- **BFCache resurrected the suspended identity's live document** after two Back presses; `location.replace` fixed it. Those tests ran Chrome with `--disable-back-forward-cache` where history did not matter; this plan never does (decision 5), so T14 measures the real cache.
- **An extension reload leaks**: 52 to 64 of ~3600 requests left with profile cookies during the reload window, and a `chrome.debugger` session outlived the extension's service worker and had to be re-adopted. T19 (P6.4) measures both.
- **A service worker holding an IndexedDB connection blocks `deleteDatabase`** for 5 s and the delete runs later anyway. Namespaces avoid deletes during a switch; the reset of a session (P4.7) uses the cancellable probe from that POC before any destructive step.
- **Baselines.** Single-tab switches took 18 to 46 ms when no request was in flight and 1528 ms when the harness waited for a keepalive request; a bootstrap added 0.7 to 1.2 ms per fetch and under 1 ms per page load. P4 reports its numbers against these.
- **Playwright specifics.** `newPage` sets `openerTabId`, so outsider tabs are created with `chrome.windows.create` from the extension; Playwright grants user activation, so lost gestures are invisible in tests; CDP `Extensions.triggerAction` opens the extension's action from a test.

## 4. How acceptance is checked

- Every acceptance criterion names a test file and the `vp run` command that runs it. A criterion with no automated check does not close a task; it goes to [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md).
- A phase closes when its tasks are `[x]` in [CHECKLIST.md](CHECKLIST.md), `vp run verify` exits 0 on the branch, for phases that own an order-critical scenario the checklist records the `vp run test:stress` run, and the checklist records a Codex code review of the phase's commits (model `gpt-6.1-sol`, high reasoning effort) with the findings the orchestrator applied and the ones it rejected, each with a reason (checklist resume protocol, step 6).
- Layers, all run by `vp run verify` inside Docker unless noted:

| Layer       | Files                                                                                      | Command                                 | Added in |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------- | -------- |
| Unit        | `{apps,packages}/*/tests/*.test.ts`                                                        | `vp run test:unit`                      | exists   |
| Component   | `*.browser.test.ts(x)` in Vitest Browser Mode: isolation patches against real browser APIs | `vp run test:components`                | exists   |
| Browser     | `tests/browser/*.spec.ts`: Google Chrome Stable, extension loaded, fixture, observer       | `vp run test:browser`                   | P0.2     |
| Experiments | `tests/experiments/*.spec.ts`: hypotheses that write verdicts                              | `vp run test:experiments`               | P0.4     |
| Stress      | the specs tagged `@order-critical`, 100 iterations, varied conditions                      | `vp run test:stress` (outside `verify`) | P1.2     |
| Container   | `tests/container/*.checks.mjs`: image reports Google Chrome ≥ 144, versions file           | `vp run test:container`                 | P0.2     |
| Docs        | `scripts/check-docs.mjs`: links and anchors resolve, generated tables current              | `vp run docs:check`                     | P0.1     |

- Coverage thresholds (80/80/80/75), Knip, jscpd (4%), lint caps, and the architecture rules apply to every new workspace. Vendored SplitSession files are tested through the modules that import them; they are not excluded from analysis.
- `docs/poc/namespace-sessions/CAPABILITIES.md` is generated from `capabilities.json` (what `chrome.debugger` and the installed Chrome allowed) and `REPORT.md` embeds the output of `scripts/decide.mjs`; `docs:check` fails when either is stale.

## 5. Target layout

```text
apps/isolator ──► packages/worker-bootstrap ──► packages/isolation-core ──► valibot
   │                                              ▲
   └──────────────────────────────────────────────┘
apps/isolator ──► @recnrun/brand
apps/fixture: imports nothing from the workspace; nothing imports it
tests/browser, tests/experiments ──► apps/fixture (to start it), @playwright/test
```

| Workspace                     | Holds (source §14 structure)                                                                                                                                                                                                                                          | May import                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `packages/isolation-core`     | `isolation-core`: schemas of source §4 (`EnvironmentState`, `ExecutionOwner`, phases, epochs), namespace contract (`toRaw`/`owns`/`fromRaw`), patches per API, realm entries for Window and WorkerGlobalScope, handshake, cookie jar semantics, vendored SplitSession | `valibot`                                     |
| `packages/worker-bootstrap`   | `worker-bootstrap`: builds `isolation-core` into one self-contained script (`BOOTSTRAP_SOURCE`, its hash, its version) for `Runtime.evaluate`, `importScripts`, `Fetch` wrappers, and web-accessible resources                                                        | `isolation-core`                              |
| `apps/isolator`               | `extension` + `coordinator`: background (coordinator, `chrome.debugger` transport, DNR/webRequest, discovery graph, journal in `chrome.storage`), content scripts, popup and dashboard (Preact), diagnostics export                                                   | `worker-bootstrap`, `isolation-core`, `brand` |
| `apps/fixture`                | `fixtures`: three origins (`app.localhost:4600`, `api.localhost:4601`, `idp.localhost:4602`) plus a staging copy on `app.localhost:4603`; server ledger; frozen build hashes                                                                                          | nothing from the workspace                    |
| `tests/browser`               | `tests/e2e` of the source: Chrome launch, extension loading, observer, specs T01 to T23 (automated parts)                                                                                                                                                             | fixture, Playwright                           |
| `tests/experiments`           | `experiments`: hypothesis specs, verdict writer                                                                                                                                                                                                                       | fixture, Playwright                           |
| `docs/poc/namespace-sessions` | `reports`: this plan, checklist, manual items, `CAPABILITIES.md`, `experiments/E*.md`, `REPORT.md`                                                                                                                                                                    | n/a                                           |

`isolation-core` never references `chrome.*`, `window`, or `document` at module scope: the same code runs in pages, dedicated workers, shared workers, and service workers, and unit tests run it in Node with fake globals.

## 6. Phases

Task IDs are stable; the checklist uses them. "Accept" lines are the automated checks. "Manual" lines name items in [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md). "Hypotheses" lines list what an experiment task must run; each gets a verdict.

### P0: Audit, harness, and capability map (source §14 deliverable 1)

Goal: branded Chrome in Docker runs the extension; the fixture is frozen; `chrome.debugger`'s real capabilities on that Chrome are a file; the observer cannot cheat.

- **P0.1 Plan documents and `docs:check`.** This plan, the checklist, the manual items, the verbatim source. Port `scripts/check-docs.mjs` from the local-engine branch (commit `62cd1c1`): every relative Markdown link and anchor resolves; wired as `vp run docs:check` inside `verify`. Add the POC to the `docs/` list in `AGENTS.md`.
  Accept: `node --test scripts/check-docs.checks.mjs` passes; `vp run docs:check` exits 1 on a broken link in a scratch copy and 0 on the branch.
- **P0.2 Google Chrome Stable in Docker and the browser layer.** `Dockerfile.tests` installs Google Chrome Stable from Google's apt repository and writes `/opt/recnrun/versions.json` (Chrome, Node, pnpm, Playwright). `tests/browser/fixtures/chrome.ts` launches it headed on Xvfb with a throwaway profile and the flags of decision 5, waits for `DevToolsActivePort`, connects Playwright with `connectOverCDP`, tears down. `vp run test:browser` and `vp run test:experiments` run in Docker; `tests/container/runner.checks.mjs` asserts `Google Chrome` and a version of 144 or more.
  Accept: `tests/browser/chrome.spec.ts` connects and reads `Browser.getVersion` with product `Chrome/<version>`; `tests/container/runner.checks.mjs` passes.
- **P0.3 Load the unpacked extension into branded Chrome.** Experiment E0.
  Hypotheses: (a) launch with `--remote-debugging-pipe --enable-unsafe-extension-debugging`, send `Extensions.loadUnpacked` on the browser session, then `chrome.management.getSelf` from the extension answers; (b) a managed policy file under `/etc/opt/chrome/policies/managed/` with `ExtensionSettings` `force_installed` and an `update_url` on a loopback update server serving a CRX3 packed by the harness; (c) neither: record, and fall back to Playwright Chromium labelled `diagnostic`.
  Report: [experiments/E0.md](experiments/E0.md).
  Accept: `tests/experiments/E0-load-extension.spec.ts` writes a verdict per hypothesis; `tests/browser/fixtures/extension.ts` exports a loader that uses the first passing method and fails with the remedy when none passes; `capabilities.json` has `extensionLoad.method` and `chrome.version`. Manual: M-P0.a, M-P0.b.
- **P0.4 `chrome.debugger` capability probe.** Experiment E1, run from inside the extension against the fixture.
  Hypotheses: `getTargets()` lists the fixture's service worker, shared worker, and dedicated worker, with their `type` strings; `attach({ targetId })` to each worker type; `attach({ tabId })` then `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })` reports `attachedToTarget` for iframes, dedicated workers, and (hypothesis) the service worker; `Target.getTargets` from a tab session lists browser-wide targets; each domain of source §5 (`ServiceWorker.enable`, `Fetch.enable` with `patterns` on worker scripts, `Storage.getCookies`, `Network.setCookie`, `Runtime.evaluate` on a worker session, `Debugger.pause`, `Runtime.terminateExecution`, `Target.closeTarget` on a worker) returns a result or the exact error string; the `debugger` infobar does not appear with `--silent-debugger-extension-api`.
  Accept: `tests/experiments/E1-debugger-capabilities.spec.ts` writes every probe as `allowed | rejected(<error>) | unavailable`; `scripts/generate-capabilities.mjs` renders `CAPABILITIES.md`; `vp run docs:check` fails when the table is stale.
- **P0.5 SplitSession vendoring and license.** Copy the modules of source §3 at the pinned commit into `packages/isolation-core/vendor/splitsession/` with `LICENSE` (MIT) and `NOTICE` (commit, date, files). `vendor-manifest.json` has the SHA-256 of each file.
  Accept: `packages/isolation-core/tests/vendor.test.ts` recomputes the hashes and fails on a modified or missing file or a missing license header; Knip and jscpd run over the vendored files.
- **P0.6 Fixture application, frozen.** `apps/fixture` serves: a login form on `idp.localhost:4602` (cookie session, `302` back to the app, a popup variant, a silent-renew iframe variant); the app on `app.localhost:4600` with a classic service worker and a module service worker variant (`?sw=classic|module|imports|dynamic`), `importScripts`, static and dynamic imports, Cache Storage precache, offline shell, navigation preload, push and Background Sync registration; the API on `api.localhost:4601` with `credentials: include` calls, a slow endpoint (`?ms=`), a redirect chain, a `Vary: Cookie` private response, WebSocket and EventSource; a staging copy on `app.localhost:4603` sharing the same IdP and API; pages that open IndexedDB, Cache Storage, localStorage, sessionStorage, OPFS, Web Locks, BroadcastChannel, dedicated and shared workers, and that make an authenticated request from the first statement of every worker. The server ledger (`GET /__ledger`) records user, path, cookie hash, sequence, `Sec-Fetch-*` headers, and timestamp per request, and a marker endpoint the pages hit before their first effect. The fixture has no RECnRun code and no cooperation with session selection. `apps/fixture/freeze.json` holds the SHA-256 of every built asset.
  Accept: `tests/browser/fixture.spec.ts` (no extension) opens every route, the ledger shows the first worker request before the page's first paint marker, and `apps/fixture/tests/freeze.test.ts` fails if a built asset's hash differs from `freeze.json` (changing the fixture after the freeze requires a new freeze and a checklist note, source §16).
- **P0.7 Evidence pipeline and observer allowlist.** `tests/browser/observer/`: a CDP observer that may only call the inspection commands of decision 5, redacts cookie values and tokens to SHA-256, and writes the evidence set of decision 7. `tests/observer-allowlist.test.ts` scans `tests/**` for CDP commands outside the allowlist and for forbidden launch flags. `egress.test.ts` runs the extension's background with a `fetch`/`WebSocket` shim that throws on any non-loopback host.
  Accept: the allowlist test fails on a scratch spec that calls `Fetch.enable`; a run of `tests/browser/fixture.spec.ts` leaves `.artifacts/evidence/<run>/{trace.jsonl,ledger.json,storage.json,counters.json}`; no raw cookie value appears in any evidence file (`redaction.test.ts`).

Gate P0: `vp run verify` exits 0; `CAPABILITIES.md` committed with the Chrome version it was generated on.

### P1: Minimal service-worker proof (source §5, §14 deliverable 2)

Goal: demonstrate or refute, on branded Chrome, that the extension can run its bootstrap before the first statement of a worker on every activation path, stop the worker, and control its restart. No UI, no namespacing beyond a marker.

Every P1 spec writes to the verdicts file and to `docs/poc/namespace-sessions/experiments/E<n>.md` (generated: hypotheses, counts, timings, exact errors). "Before the first statement" is measured, not logged: the fixture's worker makes a request, opens a database, and opens a cache as its first statements, and the test asserts the ledger entry, the physical database name, and the cache name carry the bootstrap's marker; a `console.log("patched")` after load is not evidence (source §5).

- **P1.1 Route A: tab attach and auto-attach before `register()`.** Experiment E2.
  Hypotheses: with `attach({ tabId })` and `setAutoAttach(waitForDebuggerOnStart, flatten)` installed before the page calls `register()`, the service worker target is attached paused, `Runtime.evaluate(BOOTSTRAP_SOURCE)` runs, and `Runtime.runIfWaitingForDebugger` releases it; same for classic, module, `importScripts`, static import, dynamic import variants; child targets (nested dedicated workers) are handled recursively.
  Accept: `tests/experiments/E2-route-a-register.spec.ts`; the marker precedes the first effect in 100 of 100 iterations, or the verdict is `fail` with the first-effect-before-marker count.
- **P1.2 Route A: direct worker target, cold start, and the race.** Experiment E3; tagged `@order-critical`.
  Hypotheses: `attach({ targetId })` on a service worker target discovered through `getTargets()`/`onEvent Target.targetCreated` wins the race to the first statement; cold start by navigation after the worker was stopped; worker existing and running before the extension was enabled; wake without any tab (a push message delivered from the fixture's loopback push endpoint if branded Chrome accepts a local push service, otherwise `unavailable`).
  Accept: `tests/experiments/E3-route-a-cold.spec.ts` records the `targetCreated` → first-effect distribution (p50, p95, max) and the count of late attaches per path; `vp run test:stress` runs it 100 times; a late attach is a `fail` verdict, never a retry.
- **P1.3 Stop and restart control.** Experiment E4.
  Hypotheses (mechanisms available to the extension): `Target.closeTarget` on the worker target; `Runtime.terminateExecution`; `Debugger.pause` held until release; a DNR block on the scope plus `clients` eviction; `registration.unregister()` evaluated from a client as last resort. For each: does execution stop (ledger shows no request after the stop), can the worker come back on its own (navigation, `postMessage` from a client, push), and does the extension observe the restart before the first statement.
  Accept: `tests/experiments/E4-stop-restart.spec.ts` writes a verdict per mechanism with `stops`, `restartsUnsolicited`, `restartObservedBeforeFirstStatement`, and the side effects on registrations and subscriptions.
- **P1.4 Route B: script response transformation through `Fetch`.** Experiment E5.
  Hypotheses: `Fetch.enable` on the tab session (and, if P0.4 allowed it, on the worker session) intercepts the service worker main script on first registration, on update, and the `importScripts`/`import` requests; `Fetch.fulfillRequest` with a wrapped body keeps MIME, `Service-Worker-Allowed`, CSP, and base URL working; the wrapper never embeds the session; update detection by byte comparison still works (a changed app script installs a new version; an unchanged one does not); offline start from the persisted script executes the wrapper; `declared: transformed` is written.
  Accept: `tests/experiments/E5-route-b-fetch.spec.ts` with one verdict per load path (`first`, `update`, `offline`, `imports`); the ledger shows the marker before the first effect for the passing paths.
- **P1.5 Route B: namespace selection without baking it into the script.** Experiment E6.
  Hypotheses: (a) the wrapper's first statement is `importScripts("chrome-extension://<id>/ns/current.js")`, a web-accessible resource, redirected by a session DNR rule to the slot of the active session, so the persisted script never names a session; verify that Chrome's script cache update algorithm (imported scripts are part of the version) does not freeze the slot and that offline start still resolves it; (b) the slot is re-resolved per switch by forcing `registration.update()` from a client and the extension waits for `activated`; (c) for dedicated and shared workers, the synchronous XHR marker of the inherited evidence. Also measured: MV3 background suspended and resumed between the registration and the restart; Chrome restarted (kill and relaunch with the same profile in Docker).
  Accept: `tests/experiments/E6-route-b-selection.spec.ts`; the physical database name opened by the worker after a switch is the new session's in 100 of 100, or the verdict records the stale count.
- **P1.6 Route C: composition for pages and non-service workers.** Experiment E7.
  Hypotheses: `chrome.scripting.registerContentScripts` at `document_start` in the MAIN world patches windows before the first app script, including same-origin iframes, OOPIFs, popups, `about:blank` children, sandboxed frames; the `Worker` and `SharedWorker` constructors are wrapped so the worker runs the bootstrap first (classic: `importScripts(bootstrap)` then the original; module: a static import of the bootstrap before the original) while `self.location`, `baseURI`, relative imports, and `name` stay correct; a worker that cannot be instrumented fails closed (the constructor throws) rather than running unpatched (source §4 invariants).
  Accept: `tests/experiments/E7-route-c-pages-workers.spec.ts`; for each realm type the marker precedes the first effect, or the realm is recorded `fail-closed` with the thrown error.
- **P1.7 Original-session filter and prefix collision.** The bootstrap in "original" mode hides the reserved prefix from `indexedDB.databases()`, `caches.keys()`, `localStorage` enumeration, and `clear()`; a page that creates `__rec:` names itself is refused.
  Accept: `packages/isolation-core/tests/original-filter.test.ts` and `tests/browser/original-filter.spec.ts`.
- **P1.8 P1 report and decision point.** `scripts/decide.mjs` reads the verdicts and prints, per capability (`page`, `dedicated`, `shared`, `serviceWorker × {first, update, cold, offline, wake}`), which route passed; `experiments/REPORT-P1.md` embeds that output and the Chrome version. The owner picks the route for P2 to P6 from it; the plan does not pick in advance.
  Accept: `vp run docs:check` (the embedded output equals a fresh run of the script against the committed verdicts); every "observed" line cites a spec.

Gate P1: `vp run verify` exits 0; `vp run test:stress` recorded for E3 and E6 with zero late attaches on the passing route, or the report states NO-GO for that path. Manual: M-P1.a.

### P2: Namespace core (source §6, §14 deliverable 3)

Goal: pages and workers see one coherent namespace per session for every API of source §6, with the original session filtered, no network complexity yet.

- **P2.1 Model and schemas.** `isolation-core/src/model.ts`: `EnvironmentState`, `ExecutionOwner`, `Phase`, `Epoch`, `SessionId`, journal entries, handshake message, with Valibot schemas; opaque ids; collision-free encoding of `__rec:<env>:<session>:<name>`; epoch excluded from persistent names (source §4).
  Accept: `model.test.ts`: round trips, rejected malformed names, a name with the reserved prefix from the app is refused, two different (env, session) pairs never encode to the same raw name (property test).
- **P2.2 Storage.** `localStorage`/`sessionStorage` proxy: methods, property access, `length`, `key`, enumeration, `clear`, `storage` events scoped to the namespace, frames.
  Accept: `storage.browser.test.ts` (Vitest Browser Mode) and the vendored SplitSession tests adapted.
- **P2.3 IndexedDB.** `open`, `deleteDatabase`, `databases`, `name`; transactions, upgrades, `blocked`, `versionchange` preserved; live handles of an old execution die with it.
  Accept: `indexed-db.browser.test.ts`; `tests/browser/idb-handles.spec.ts` shows an old handle rejects after a switch (T06 part).
- **P2.4 Cache Storage.** `open`, `has`, `delete`, `keys`, `match`, `Cache.*`; private caches by default including assets.
  Accept: `cache-storage.browser.test.ts`; a cross-namespace `caches.match` returns `undefined` (T15 part).
- **P2.5 Cookies facade.** `document.cookie` and Cookie Store readers over the jar view of the active session; HttpOnly invisible; attributes complete; `cookiechange` subscriptions tested.
  Accept: `cookies.test.ts` (parsing, from the vendored jar) and `cookie-store.browser.test.ts`.
- **P2.6 BroadcastChannel and Web Locks.** Namespaced names; `navigator.locks.query()` filtered; pending locks released on suspension.
  Accept: `channels-locks.browser.test.ts`.
- **P2.7 WebSocket and EventSource.** Connections tagged with their owner; closed on switch; a reconnect from a revoked generation is refused.
  Accept: `sockets.browser.test.ts` with the fixture's echo server; `tests/browser/sockets.spec.ts` (T22 part).
- **P2.8 Worker realms.** The same patches installed through the route chosen in P1.8 in dedicated, shared, and service workers; per-type coverage measured.
  Accept: `tests/browser/worker-coverage.spec.ts` writes `coverage.workers` with `implemented | partial | fail-closed` per type and API (T04).
- **P2.9 OPFS, Storage Buckets, inventory.** OPFS virtual root per session including worker access handles, or `unavailable` declared; Storage Buckets and other APIs inventoried with detection tests.
  Accept: `opfs.browser.test.ts`; `inventory.test.ts` asserts every API of source §6 has a status in the capability file (never "all isolated").

Gate P2: `vp run verify` exits 0; `CAPABILITIES.md` regenerated.

### P3: Cookies and network without staging (source §7, §14 deliverable 4)

- **P3.1 Jars.** Original session reads the native cookies; new sessions use virtual jars in `chrome.storage` (permanent, source §2 item 3). Semantics from the vendored code validated: `Secure`, `HttpOnly`, `SameSite`, host-only and `Domain`, `Path`, expiry, removal, prefixes, CHIPS, same-name cookies.
  Accept: `jar.test.ts` fixture table; `tests/browser/cookies-semantics.spec.ts` (T16).
- **P3.2 Managed tabs: isolation before the first request.** Popups get an owner before their first request; destinations not yet known are covered.
  Accept: `tests/browser/first-request.spec.ts`: zero original cookies on the first request of B to the IdP and to the API (ledger), popup included; tagged `@order-critical`.
- **P3.3 Two mechanisms, one test set.** DNR + `webRequest` and `Fetch` through `chrome.debugger` run the same specs (P3.1, P3.2, P3.5); rules are never installed twice; cookie update between login and the immediate redirect measured.
  Accept: `tests/browser/mechanisms.spec.ts` produces a comparison table in the evidence; the report shows it.
- **P3.4 Requests without a `tabId`.** Attribution by target, worker, origin, and proven execution record; the "destination domain = active session" rule is refused; ambiguous cases block or serialize with a diagnostic.
  Accept: `tests/browser/attribution.spec.ts`: a worker request of A and one of B to the same API host are attributed correctly; an unattributable request is blocked and logged, never guessed.
- **P3.5 Late responses.** A response of A arriving during or after the switch updates at most A's jar; never B's; never the native jar.
  Accept: `tests/browser/late-response.spec.ts` (T05) with the fixture's slow endpoint; tagged `@order-critical`.
- **P3.6 HTTP cache and `Vary`.** Private responses are not served to another session.
  Accept: `tests/browser/http-cache.spec.ts` (T17): the ledger shows a fresh request or the observer shows a per-session cache key.
- **P3.7 Ports and same-name cookies.** Two ports of `app.localhost` with same-name cookies behave as Chrome does (no isolation by port assumed).
  Accept: `tests/browser/ports.spec.ts` (T12).

Gate P3: `vp run verify` exits 0; stress recorded for P3.2 and P3.5.

### P4: The switch transaction (source §10, §14 deliverable 5)

- **P4.1 State machine and journal.** `ACTIVE(A,e) → QUIESCING → PREPARED(B,e+1) → ACTIVE(B,e+1)` with `FAILED`; mutex per environment; concurrent switches rejected or queued explicitly; intent and epoch persisted before any effect; a copy counter that must stay at 0 bytes.
  Accept: `coordinator/tests/switch.test.ts` covers every transition and rejects every illegal one; `journal.test.ts` recovers from a truncated journal.
- **P4.2 Admission barrier and drain.** New operations of the old generation refused in pages, workers, and network; in-flight transactions and requests drained with an explicit timeout; cancel only when safe; uncertain outcomes recorded, never retried.
  Accept: `tests/browser/barrier.spec.ts`: a POST in flight at the switch is recorded `uncertain` in the journal and appears once in the ledger (R8).
- **P4.3 Park and reload clients.** Old clients parked or unloaded; the tab kept when `sessionStorage` must survive; BFCache, history, prerender, popup, and reconnect cannot resume the old generation.
  Accept: `tests/browser/resurrection.spec.ts` (T14): Back twice, duplicate tab, popup, new tab, prerender; none shows A's data while B is active; `tests/browser/session-storage.spec.ts` records whether `sessionStorage` survived (a loss is a declared limit, not a silent replacement).
- **P4.4 Exclusivity of the original session.** Other tabs, PWA windows, hidden iframes, and workers of the environment stop executing A while B is active.
  Accept: `tests/browser/exclusivity.spec.ts` (T13): the ledger shows no request from A's identity after `ACTIVE(B)`.
- **P4.5 Workers across the switch.** Stop confirmed, recreate under B, patch confirmed before the app runs; no partial patch over a warm worker; old handles unusable.
  Accept: `tests/browser/worker-switch.spec.ts` (T06): the IndexedDB transaction of A in flight ends per the documented policy; B's worker opens B's physical database.
- **P4.6 Negative control: plain reload.** A reload without the coordinator is shown to leave A's worker, cache, and cookies in place.
  Accept: `tests/browser/reload-control.spec.ts` (T07) asserts the leak exists, labelled `control`.
- **P4.7 Reset of a suspended session.** Deletes only its namespace and jar, after suspension, with the cancellable IndexedDB probe first; never offered for the original session.
  Accept: `tests/browser/reset.spec.ts`: the other sessions' inventories are byte-identical before and after.
- **P4.8 A → B → A → C → A end to end.** The full cycle on the fixture with login, data, and server-side identity per step.
  Accept: `tests/browser/cycle.spec.ts` (T01): correct user in the ledger at every step; `counters.copiedBytes === 0`; timings p50/p95 written to the evidence; tagged `@order-critical`.

Gate P4: `vp run verify` exits 0; stress recorded for P4.3 and P4.8.

### P5: Automatic discovery (source §8, §14 deliverable 6)

- **P5.1 Evidence graph.** tab/document/frame/opener → request/redirect → origin → worker registration/version → shared resources, from `initiator`, `requestId`, `documentId`, target.
  Accept: `discovery/tests/graph.test.ts` from recorded traces; `tests/browser/discovery.spec.ts` learns `idp.localhost` and `api.localhost` without them appearing in the extension's source (`no-host-list.test.ts`).
- **P5.2 Unknown dependencies first met in a worker.** Protected before the request or recorded `uncovered`; never "learned after a leak".
  Accept: `tests/browser/worker-discovery.spec.ts`: the first worker request to a new host carries B's identity or is blocked and reported.
- **P5.3 Redirects, popups, silent renew, cross-origin API, subdomains, ports.** Zero original cookie on B's first request through each path.
  Accept: `tests/browser/sso-paths.spec.ts` (T10).
- **P5.4 Shared resources across environments.** Dev and staging share the IdP and API: the conflict is detected, exclusivity widened, conflicting contexts parked before activation, and the effect is shown in the UI state; personal tabs outside the environment are never closed silently (activation blocks with an explanation).
  Accept: `tests/browser/shared-sso.spec.ts` (T11) and `tests/browser/outsider-tabs.spec.ts` (an unrelated tab on the IdP blocks activation with a diagnostic).

Gate P5: `vp run verify` exits 0.

### P6: Compatibility (source §11, §14 deliverable 7)

- **P6.1 Offline and cache hits.** Fixture served offline by its service worker from the right session's cache, with authentication of the right session; navigation preload.
  Accept: `tests/browser/offline.spec.ts` (T09) with the fixture's network cut by the fixture server (never by the harness's route interception).
- **P6.2 Service worker lifecycle.** Cold, wake without tab (where P1.2 found a path), `install`/`waiting`/`activate`, update with changed bytes; bootstrap wins on every supported path.
  Accept: `tests/browser/sw-lifecycle.spec.ts` (T08, T02).
- **P6.3 Background events.** Push, Background Sync, periodic sync, `cookiechange`, `notificationclick` created under A during B: not executed as B; preserved or declared with the exact gap.
  Accept: `tests/browser/background-events.spec.ts` (T18) with the fixture's loopback push endpoint; `capabilities.json` gets `backgroundEvents.*`.
- **P6.4 Failures.** MV3 background suspended and resumed, debugger detached (`onDetach`), extension reload, Chrome killed and relaunched with the same profile, truncated journal; what persists and what does not is measured, fail-closed where possible, classified where not.
  Accept: `tests/browser/failures.spec.ts` (T19); no silent unsafe resume.
- **P6.5 Volume and pressure.** 1, 100, and 500 MB per session as the quota allows; 100 switches; no copy proportional to volume; no contamination.
  Accept: `tests/browser/volume.spec.ts` (T20) writes the timing table; `counters.copiedBytes === 0`.
- **P6.6 Expired sessions and extra APIs.** Server-side expiry triggers explicit re-authentication (T21); OPFS, locks, channels, WebSocket per API status (T22).
  Accept: `tests/browser/expiry.spec.ts`, `tests/browser/extra-apis.spec.ts`.
- **P6.7 Framework lab.** A second fixture under `apps/fixture/lab/` with an Angular-style app, Dexie, and an OIDC flow equivalent to Keycloak (code + PKCE, silent renew iframe, logout redirect), all loopback; earlier fixtures kept.
  Accept: `tests/browser/lab.spec.ts` runs T01 and T10 on it. Manual: M-P6.a, M-P6.b.

Gate P6: `vp run verify` exits 0; stress recorded for P6.1 and P6.2.

### P7: Packaging (source §14 deliverable 8)

- **P7.1 Package and manifest guard.** `vp run isolator:zip` produces the extension package; `manifest.checks.mjs` lists every permission and host permission with the task that needs it and fails on an unlisted one; no `nativeMessaging`, no `externally_connectable`, no update URL.
  Accept: `apps/isolator/scripts/manifest.checks.mjs`.
- **P7.2 UI.** Popup and dashboard: detected environment, original/A/B/C sessions, create/activate/suspend, switch state, verified capabilities, parked contexts, APIs out of coverage, diagnostics export (the evidence set as a file); no domain editor.
  Accept: `apps/isolator/tests/*.browser.test.tsx` for the components; `tests/browser/ui.spec.ts` drives the dashboard through the extension's page and exports diagnostics.
- **P7.3 T23, automated part.** The cycle of P4.8 driven only through the dashboard page and the fixture's pages, with the observer disabled (`RECNRUN_OBSERVER=0`): no CDP command from the harness at all, evidence from the ledger and the exported diagnostics only.
  Accept: `tests/browser/t23-no-observer.spec.ts`; `observer-allowlist.test.ts` asserts the spec imports nothing from `tests/browser/observer/`. Manual: M-P7.a, M-P7.b, M-P7.c.
- **P7.4 Uninstall and data.** Uninstalling the extension leaves session namespaces and jars in place (nothing deleted automatically); reinstall finds them.
  Accept: `tests/browser/uninstall.spec.ts` through `Extensions.uninstall` where P0.3 allowed it, else `unavailable` recorded and M-P7.b carries it.

Gate P7: `vp run verify` exits 0.

### P8: Final report and decision (source §15, §16, §14 deliverable 9)

- **P8.1 Decision script.** `scripts/decide.mjs` applies source §15 to the verdicts and the T-matrix results: `GO extension-only`, `GO partial` (with the allowed and blocked scenarios), or `NO-GO for the tested architecture`; any leak, hidden copy, fixture change after the freeze, service worker bypass, disabled worker, profile-based isolation counted as proof, mocked test, or runtime dependency outside the extension forces "no GO". Control and diagnostic runs are excluded.
  Accept: `scripts/decide.checks.mjs` with fixture verdict files for each outcome.
- **P8.2 Report.** `docs/poc/namespace-sessions/REPORT.md`: the answers to the nine questions of source §16, the technique per capability, the T-matrix with status and spec, the limits with reproducers, the manual items with their recorded results, the next step inside the same architecture. Observed, inferred, and untested are kept apart.
  Accept: `vp run docs:check` (embedded decision output current; every observed claim cites a spec); the checklist records the final `verify` and `stress` runs.

Gate P8: `vp run verify` exits 0. Release of the report: manual items of [MANUAL_VALIDATION.md](MANUAL_VALIDATION.md) recorded.

## 7. Test matrix (source §12)

| ID  | Scenario                                               | Task       | Automation                                             |
| --- | ------------------------------------------------------ | ---------- | ------------------------------------------------------ |
| T01 | Original → B → original → C → original                 | P4.8       | automated, stress                                      |
| T02 | Worker installed and active before RECnRun             | P6.2       | automated                                              |
| T03 | First worker statement touches DB/cache/network        | P1.1–P1.6  | automated, stress                                      |
| T04 | Dedicated, shared, service; classic/module             | P2.8       | automated                                              |
| T05 | Late response of A during the switch to B              | P3.5       | automated, stress                                      |
| T06 | IDB transaction, cache handle, token in memory         | P2.3, P4.5 | automated                                              |
| T07 | Plain reload as negative control                       | P4.6       | automated (labelled control)                           |
| T08 | Cold worker, wake without tab, update/install/activate | P6.2       | automated; wake without tab per P1.2 verdict           |
| T09 | Cache hit, offline navigation, navigation preload      | P6.1       | automated                                              |
| T10 | Unknown API/SSO, popup, redirect, silent renew         | P5.3       | automated                                              |
| T11 | Same SSO/API in dev and staging                        | P5.4       | automated                                              |
| T12 | Two localhost ports, same-name cookies                 | P3.7       | automated                                              |
| T13 | Other original tab, PWA, hidden iframe                 | P4.4       | automated                                              |
| T14 | BFCache, duplicate, popup, new tab                     | P4.3       | automated, stress                                      |
| T15 | clear/delete/list and prefix collision                 | P1.7, P2.4 | automated                                              |
| T16 | credentials, SameSite, HttpOnly, CHIPS, redirects      | P3.1       | automated                                              |
| T17 | HTTP cache with private responses and Vary             | P3.6       | automated                                              |
| T18 | Push/sync/cookiechange of A during B                   | P6.3       | automated where branded Chrome accepts a loopback push |
| T19 | Crash, detach, restart, update                         | P6.4       | automated in Docker; the person's profile is M-P4.a    |
| T20 | Large data, quota pressure, 100 switches               | P6.5       | automated                                              |
| T21 | Server-side expiry                                     | P6.6       | automated                                              |
| T22 | OPFS, locks, channels, WebSocket                       | P2.9, P6.6 | automated per API status                               |
| T23 | Extension only, runner and observers off               | P7.3       | partly automated (no observer); strict form is M-P7.a  |

## 8. Working rules specific to this plan

- A hypothesis that fails is recorded and the next hypothesis inside the extension is tried (source §16); a hypothesis that was not executed blocks the task. No external component is ever a fallback.
- When a defect of the isolator appears, the failing scenario becomes a regression spec under `tests/browser/regressions/<id>.spec.ts` before the fix; the fixture is never edited to make the case easier (its hashes are frozen).
- Results are reported as "Google Chrome <version> on Linux in Docker" until a manual item records the same on macOS; Windows is "not validated" until someone runs it.
- Evidence files distinguish `observed`, `inferred`, and `untested`; the report copies that distinction.
- Nothing is pushed to `master`; this branch is pushed and its pull request updated after each phase gate, with the owner's authorization for anything beyond that.
