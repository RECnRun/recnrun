---
paths:
  - "tests/**"
  - "**/tests/**"
  - "playwright*.config.ts"
  - "**/vitest*.config.ts"
  - "scripts/test-container.mjs"
  - "Dockerfile.tests"
---

# Tests

## Layers

| Layer       | Files                                                                         | Command                   |
| ----------- | ----------------------------------------------------------------------------- | ------------------------- |
| Node unit   | `{apps,packages}/*/tests/*.test.ts`                                           | `vp run test:unit`        |
| Component   | `*.browser.test.ts(x)` in Vitest Browser Mode, Chromium                       | `vp run test:components`  |
| End-to-end  | `tests/e2e/*.spec.ts`, headed Playwright Chromium, built website + extension  | `vp run test:e2e`         |
| Browser     | `tests/browser/*.spec.ts`, Google Chrome Stable over CDP, headed on Xvfb      | `vp run test:browser`     |
| Experiments | `tests/experiments/*.spec.ts`, POC hypotheses on the browser layer's fixtures | `vp run test:experiments` |
| Container   | `tests/container/*.checks.mjs` (Node): runner, image ships Google Chrome 144+ | `vp run test:container`   |
| Scripts     | `scripts/*.checks.mjs` (Node)                                                 | `vp run test:scripts`     |

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
- Launch flags are limited by [PLAN.md decision 5](../../docs/poc/namespace-sessions/PLAN.md#2-decisions): profile location, `--remote-debugging-port=0`, `--no-first-run`, `--silent-debugger-extension-api`, and `--no-sandbox` only when `RECNRUN_TEST_CONTAINER=1` (Chrome runs as root there). Add flags through the `chromeArgs` option (`test.use`) or `launchChrome({ args })`; never `--disable-back-forward-cache` or `--load-extension`.
- The fixture resolves Chrome from `RECNRUN_CHROME_PATH`, then `google-chrome` or `google-chrome-stable` on `PATH`, then the macOS app, and fails with the remedy when none exists.
- Every Docker run writes `versions.json` (Chrome, Node, pnpm, Playwright, image id). Report results as "Google Chrome <version> on Linux in Docker".
- `test:experiments:local` passes `--pass-with-no-tests` until the first experiment lands.
