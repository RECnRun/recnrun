---
paths:
  - "tests/**"
  - "**/tests/**"
  - "playwright*.config.ts"
  - "**/vitest*.config.ts"
  - "scripts/test-container.mjs"
  - "scripts/test-stress.mjs"
  - "Dockerfile.tests"
---

# Tests

## Layers

| Layer       | Files                                                                                  | Command                   |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------- |
| Node unit   | `{apps,packages}/*/tests/*.test.ts`, `tests/*.test.ts` (the harness itself)            | `vp run test:unit`        |
| Component   | `*.browser.test.ts(x)` in Vitest Browser Mode, Chromium                                | `vp run test:components`  |
| End-to-end  | `tests/e2e/*.spec.ts`, headed Playwright Chromium, built website + extension           | `vp run test:e2e`         |
| Browser     | `tests/browser/*.spec.ts`, Google Chrome Stable over CDP, headed on Xvfb               | `vp run test:browser`     |
| Experiments | `tests/experiments/*.spec.ts`, POC hypotheses on the browser layer's fixtures          | `vp run test:experiments` |
| Stress      | browser and experiment specs tagged `@order-critical`, 100 iterations, not in `verify` | `vp run test:stress`      |
| Container   | `tests/container/*.checks.mjs` (Node): runner, image ships Google Chrome 144+          | `vp run test:container`   |
| Scripts     | `scripts/*.checks.mjs` (Node)                                                          | `vp run test:scripts`     |

- Keep schemas, protocol handling, handlers, and view models in Node unit tests; extract pure functions when that makes a rule testable.
- Prove detection, the install banner, data display, origin checks, and CSP end to end, with the real extension loaded.

## Running

- Public commands run in Docker, headed Chromium or Google Chrome Stable on an isolated Xvfb display. Keep `headless: false` (extensions need a headed browser), and never connect the container display to the host.
- Browser tests stay serial (`--workers=1`), coverage included.
- Pass Playwright arguments after `--`, for example `vp run test:e2e -- tests/e2e/explorer.spec.ts -g 'empty'`.
- On failure, read `.artifacts/docker/<run-id>/` (`run.log`, `versions.json`, `test-results`, `playwright-report`).
- `:local` variants open host windows; use them only for debugging.

## Writing end-to-end tests

- Import `test` and `expect` from `tests/e2e/fixtures/extension.ts` when the extension must be loaded; it launches a persistent Chromium context with `apps/extension/.output/chrome-mv3-test` and exposes `serviceWorker` and `seedSnapshot(snapshot)`. Import from `@playwright/test` for a browser without the extension.
- Seed data through `seedSnapshot` with fixtures from `@recnrun/domain/testing`; never drive the website into a state the extension could not produce.
- Locate by role and accessible name (`getByRole("article", { name })`, `getByRole("region", { name })`), not CSS classes.
- Prefer locator auto-waiting and `expect.poll` over fixed sleeps.
- Security tests use a second origin through `context.route` (see `origin-guard.spec.ts`) and assert that forged messages get no answer.

## Writing browser tests and experiments

- Import `test` and `expect` from `tests/browser/fixtures/chrome.ts`. Its `chrome` fixture launches Google Chrome Stable headed with a fresh `--user-data-dir`, waits for `DevToolsActivePort`, connects with `chromium.connectOverCDP`, and exposes `browser`, `cdp` (a browser-target CDP session), `version`, `userDataDir`, and `pid`; teardown disconnects, stops Chrome, and deletes the profile. `launchChrome()` starts extra instances.
- Launch flags are limited by [PLAN.md decision 5](../../docs/poc/namespace-sessions/PLAN.md#2-decisions): profile location, `--remote-debugging-port=0`, `--no-first-run`, `--silent-debugger-extension-api` (left out by `launchChrome({ silentDebugger: false })` or `loadUnpackedOverCdp(path, { silentDebugger: false })`, for the spec that drives the infobar), and `--no-sandbox` only when `RECNRUN_TEST_CONTAINER=1` (Chrome runs as root there). Add flags through the `chromeArgs` option (`test.use`) or `launchChrome({ args })`; never `--disable-back-forward-cache` or `--load-extension` on Google Chrome. The extension loaders add `--enable-unsafe-extension-debugging` and, for the pipe variant, `--remote-debugging-pipe` (`launchChrome({ pipe: true })`).
- The fixture resolves Chrome from `RECNRUN_CHROME_PATH`, then `google-chrome` or `google-chrome-stable` on `PATH`, then the macOS app, and fails with the remedy when none exists.
- Every Docker run writes `versions.json` (Chrome, Node, pnpm, Playwright, image id). Report results as "Google Chrome <version> on Linux in Docker".
- Import `test` and `expect` from `tests/browser/fixtures/extension.ts` when the isolator must be loaded. Its `extension` fixture loads `apps/isolator/.output/chrome-mv3-test` (built by `test:browser:local` and `test:experiments:local`) with the first method that works, in E0's order: CDP `Extensions.loadUnpacked`, managed policy, then Playwright's Chromium labelled `diagnostic` ([E0.md](../../docs/poc/namespace-sessions/experiments/E0.md)). It exposes `extensionId`, `method`, `label`, `chrome` (the `LaunchedChrome`), and `evaluateInBackground(expression)`, which runs in the extension's service worker through `tests/browser/fixtures/cdp-client.ts`. That client rejects every pending command when its WebSocket or pipe closes, fails, or is closed, and rejects a command Chrome has not answered within 30 s (`send`'s `timeoutMs` option changes it).
- **Calling CDP.** Send commands only as `<session>.send("Domain.method", params)` with the method as a string literal at the call site (a Playwright `CDPSession`, `chrome.pipe`, or the `cdp-client.ts` client); `tests/observer-allowlist.test.ts` scans `tests/browser` and `tests/experiments` for those call sites and fails on a command outside its allowlist (inspection commands, plus `Browser.setPermission` to deny notifications, accepted only when its params object literal says `setting: "denied"`), on `ServiceWorker.*`, `Fetch.*`, `Debugger.*`, `Emulation.*`, `Storage.clear*`, `Target.setAutoAttach`, `Page.addScriptToEvaluateOnNewDocument`, `Page.setBypassCSP`, cookie writes, `Network.setExtraHTTPHeaders`, `Network.setUserAgentOverride`, on raw `Runtime.evaluate` outside the extension loaders, on Playwright calls that send such commands or inject into the page (`route`, `addInitScript`, `addScriptTag`, `addStyleTag`, `setContent`, `evaluate`, `addCookies`, `setOffline`, and the rest of its list), and on launch flags outside decision 5 (any `--disable-*`; `--load-extension` only in `loadInChromium`). A method name passed as data to anything other than `send` is not a call site; adding a command means adding it to the allowlist with its reason.
- Import `test` and `expect` from `tests/browser/observer/fixture.ts` to record evidence. Its `observer` fixture starts the CDP observer on Chrome's first page (`observer.page` is the page to drive); call `snapshotStorage(origins)` and `collectLedger(apiBase)` before `finish()`, which writes `trace.jsonl`, `ledger.json`, `storage.json`, and `counters.json` under `.artifacts/evidence/<RECNRUN_RUN_ID>/<spec>/<test>/`, redacted by `tests/browser/observer/redact.ts`. Teardown writes them even when the test failed. `expectRedactedEvidence` checks that raw cookie values never reach the files (`tests/browser/fixture.spec.ts` shows the pattern in `afterEach`). Reset the fixture's ledger once per test, in `beforeEach`, and scope assertions with sequence checkpoints (the last `seq` before a step) instead of resetting mid-test, so `ledger.json` holds the whole test.
- **Stress** ([PLAN.md decision 8](../../docs/poc/namespace-sessions/PLAN.md#2-decisions)). Tag an order-critical spec by ending its test title with `@order-critical`. `scripts/test-stress.mjs` runs the tagged tests of `playwright.experiments.config.ts` and `playwright.browser.config.ts` serially, 100 iterations (`--iterations N` or `RECNRUN_STRESS_ITERATIONS`), with `RECNRUN_RUN_ID=<run>/stress/<iteration>-<condition>`, `RECNRUN_STRESS_ITERATION`, and `RECNRUN_STRESS_CONDITION` cycling `baseline`, `net-delay`, `cpu-load`, `cold`, `warm`, `switch-early`, `switch-late`. The spec applies `net-delay` (the fixture's `/slow?ms=`), `cold`/`warm` (worker state), and the switch moment itself, and records the condition in every verdict, even one it ignores; for `cpu-load` the runner keeps one busy thread per core running (`RECNRUN_STRESS_CPU_THREADS`). Put a late-attach count in `lateAttaches` (or `firstEffectBeforeMarker`) and make a leak a `fail` verdict, never a retry (the runner passes `--retries=0`). The runner writes `.artifacts/evidence/<run>/stress.json` (iterations, conditions, specs, per-hypothesis `pass`/`fail`/`unavailable`/`lateAttaches`, failed iterations) and exits non-zero on any `fail`, any failed Playwright run, or when no test is tagged.
- Experiments record each hypothesis with `appendVerdict` and capabilities with `mergeCapabilities` (`tests/experiments/verdicts.ts`) under `.artifacts/evidence/<RECNRUN_RUN_ID>/`. A hypothesis that fails is a verdict, not a test failure; the spec fails when a hypothesis has no verdict. Docker runs set `RECNRUN_RUN_ID` to the run id and export the directory to `.artifacts/docker/<run-id>/evidence/`.
- **Sample counts** come from `sized(full, few = 1)` in `tests/experiments/samples.ts`, never from a literal. `vp run verify` sets `RECNRUN_EXPERIMENT_SAMPLES=smoke` so every experiment runs once per hypothesis and `appendVerdict` stamps `mode: "smoke"`; a stress iteration takes `few` too. `vp run test:experiments` runs the full counts and writes the evidence the reports cite; a verdict with `mode: "smoke"` is never evidence.
