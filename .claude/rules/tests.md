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

| Layer      | Files                                                                    | Command                  |
| ---------- | ------------------------------------------------------------------------ | ------------------------ |
| Node unit  | `{apps,packages}/*/tests/*.test.ts`                                      | `vp run test:unit`       |
| Component  | `*.browser.test.ts(x)` in Vitest Browser Mode, Chromium                  | `vp run test:components` |
| End-to-end | `tests/e2e/*.spec.ts`, headed Playwright, built website + test extension | `vp run test:e2e`        |

- Keep schemas, protocol handling, handlers, and view models in Node unit tests; extract pure functions when that makes a rule testable.
- Both apps' `vitest.browser.config.ts` call `browserProject(name, dir)` from the root `vitest.browser.shared.ts`; change the Browser Mode setup there, once.
- Prove detection, the install banner, data display, origin checks, and CSP end to end, with the real extension loaded.

## Running

- Public commands run in Docker, headed Chromium on an isolated Xvfb display. Keep `headless: false` (extensions need a headed Chromium), and never connect the container display to the host.
- Browser tests stay serial (`--workers=1`), coverage included.
- The Node projects run with `isolate: false`, so files of one project share a worker: reset module state in `beforeEach` (as `fakeBrowser.reset()` does) instead of relying on a fresh module per file.
- Pass Playwright arguments after `--`, for example `vp run test:e2e -- tests/e2e/dashboard-frame.spec.ts -g 'empty'`.
- On failure, read `.artifacts/docker/<run-id>/` (`run.log`, `test-results`, `playwright-report`).
- `vp run test:coverage` also fails when the measured file set differs from the source tree minus the configured excludes, or when any file with executable code is under the per-file floor of 80% lines, statements, and functions and 75% branches (`scripts/coverage.checks.mjs`); a new source folder outside `apps/*/src` or `packages/*/src` needs that script and `coverage.include` updated together. Lift a file under the floor with tests of its behavior, never by excluding it.
- `:local` variants open host windows; use them only for debugging.

## Writing end-to-end tests

- Import `test` and `expect` from `tests/e2e/fixtures/extension.ts` when the extension must be loaded; it launches a persistent Chromium context with `apps/extension/.output/chrome-mv3-test` and exposes `serviceWorker` and `seedSnapshot(snapshot)`. With `test.use({ remoteDebuggingPort })`, `clickToolbarIcon(page)` fires the real toolbar action on that page's tab (browser-level CDP `Extensions.triggerAction`), user gesture included. `test.use({ incognitoAccess: true })` starts from a profile that already allows the extension in Incognito. `tests/e2e/fixtures/session.ts` locates the dashboard frame, the PiP window, and tab items, and opens the session. `tests/e2e/fixtures/tabs.ts` reads Chrome's tabs and the stored session through the service worker, since Playwright emulates focus; it also opens incognito tabs, moves the real focus (`focusTab`), and reads every stored value as text (`storedText`) for privacy checks. Import from `@playwright/test` for a browser without the extension.
- Seed data through `seedSnapshot` with fixtures from `@recnrun/domain/testing`; never drive the website into a state the extension could not produce.
- Click in a dashboard frame with `clickInDashboard(locator)` from `fixtures/session.ts`, never `locator.click()`: Chromium can route a click that comes before the frame's hit-test data to the site ([TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md)).
- Locate by role and accessible name (`getByRole("article", { name })`, `getByRole("region", { name })`), not CSS classes.
- Prefer locator auto-waiting and `expect.poll` over fixed sleeps.
- Security tests use a second origin through `context.route` (see `origin-guard.spec.ts`) and assert that forged messages get no answer.
