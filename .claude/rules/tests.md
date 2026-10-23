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
- Prove detection, the install banner, data display, origin checks, and CSP end to end, with the real extension loaded.

## Running

- Public commands run in Docker, headed Chromium on an isolated Xvfb display. Keep `headless: false` (extensions need a headed Chromium), and never connect the container display to the host.
- Browser tests stay serial (`--workers=1`), coverage included.
- Pass Playwright arguments after `--`, for example `vp run test:e2e -- tests/e2e/dashboard-tab.spec.ts -g 'empty'`.
- On failure, read `.artifacts/docker/<run-id>/` (`run.log`, `test-results`, `playwright-report`).
- `:local` variants open host windows; use them only for debugging.

## Writing end-to-end tests

- Import `test` and `expect` from `tests/e2e/fixtures/extension.ts` when the extension must be loaded; it launches a persistent Chromium context with `apps/extension/.output/chrome-mv3-test` and exposes `serviceWorker` and `seedSnapshot(snapshot)`. With `test.use({ remoteDebuggingPort })`, `clickToolbarIcon(page)` fires the real toolbar action on that page's tab (browser-level CDP `Extensions.triggerAction`), user gesture included; `tests/e2e/fixtures/tabs.ts` runs the other triggers through the test build's `recnrunOpenSession` and `recnrunOpenDashboard`. Import from `@playwright/test` for a browser without the extension.
- Seed data through `seedSnapshot` with fixtures from `@recnrun/domain/testing`; never drive the website into a state the extension could not produce.
- Locate by role and accessible name (`getByRole("article", { name })`, `getByRole("region", { name })`), not CSS classes.
- Prefer locator auto-waiting and `expect.poll` over fixed sleeps.
- Security tests use a second origin through `context.route` (see `origin-guard.spec.ts`) and assert that forged messages get no answer.
