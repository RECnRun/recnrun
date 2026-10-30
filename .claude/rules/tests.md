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
- Prove detection, the install banner, recording through the public API and the popup, live steps, origin checks, and CSP end to end, with the real extension loaded.

## Running

- Public commands run in Docker, headed Chromium on an isolated Xvfb display. Keep `headless: false` (extensions need a headed Chromium), and never connect the container display to the host.
- Browser tests stay serial (`--workers=1`), coverage included.
- Pass Playwright arguments after `--`, for example `vp run test:e2e -- tests/e2e/workflows.spec.ts -g 'popup'`.
- On failure, read `.artifacts/docker/<run-id>/` (`run.log`, `test-results`, `playwright-report`).
- `:local` variants open host windows; use them only for debugging.

## Writing end-to-end tests

- Import `test` and `expect` from `tests/e2e/fixtures/extension.ts` when the extension must be loaded; it launches a persistent Chromium context with `apps/extension/.output/chrome-mv3-test` and exposes `serviceWorker`. Import from `@playwright/test` for a browser without the extension.
- Produce data the way a user would: start a workflow through the public API with `callApi` from `tests/e2e/fixtures/public-api.ts` (it hardcodes `EXTENSION_ID`) or from the popup opened at `chrome-extension://<id>/popup.html`, and interact with the fixture app served by `context.route` on `APP_ORIGIN`. Never drive the website into a state the extension could not produce.
- The test build pre-grants `localhost`; a test that needs Chrome's permission prompt cannot run in Playwright and stays a manual check in `docs/MILESTONES.md`.
- Locate by role and accessible name (`getByRole("article", { name })`, `getByRole("region", { name })`), not CSS classes.
- Prefer locator auto-waiting and `expect.poll` over fixed sleeps.
- Security tests use a second origin through `context.route` (see `origin-guard.spec.ts`) and assert that forged messages get no answer.
