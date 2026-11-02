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

| Layer      | Files                                                                                         | Command                                               |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Node unit  | `{apps,packages}/*/tests/*.test.ts`                                                           | `vp run test:unit`                                    |
| Component  | `*.browser.test.ts(x)` in Vitest Browser Mode, Chromium                                       | `vp run test:components`                              |
| End-to-end | `tests/e2e/*.spec.ts`, Playwright against the built website                                   | `vp run test:e2e`                                     |
| Browser    | `tests/browser/*.spec.ts`, Google Chrome Stable over CDP, headed on Xvfb                      | `vp run test:browser`                                 |
| Scripts    | `scripts/*.checks.mjs`, `scripts/*-hooks/*.checks.mjs`, `tests/container/*.checks.mjs` (Node) | `vp run test:scripts`, `test:hooks`, `test:container` |

[PLAN.md §3](../../docs/plan/PLAN.md#3-how-acceptance-is-checked) adds layers as the engine arrives: `tests/contract` in F2.1 and `tests/distribution` in F7.1. Each lands with its Docker wiring and its own section here.

- Keep schemas, protocol handling, handlers, and view models in Node unit tests; extract pure functions when that makes a rule testable.
- Prove the landing copy and the website's CSP end to end.
- A test that needs Chrome's own dialog, the default profile, or a second machine is not automated: add it to [MANUAL_VALIDATION.md](../../docs/plan/MANUAL_VALIDATION.md) instead.

## Running

- Public commands run in Docker on an isolated Xvfb display; never connect the container display to the host.
- Browser tests stay serial (`--workers=1`), coverage included.
- Pass Playwright arguments after `--`, for example `vp run test:e2e -- tests/e2e/landing.spec.ts -g 'install'`.
- On failure, read `.artifacts/docker/<run-id>/` (`run.log`, `versions.json`, `test-results`, `playwright-report`).
- `:local` variants run on the host; use them only for debugging.

## Writing end-to-end tests

- Import `test` and `expect` from `@playwright/test`; the config's `webServer` serves the built website.
- Locate by role and accessible name (`getByRole("region", { name })`, `getByRole("heading", { level: 1 })`), not CSS classes.
- Prefer locator auto-waiting and `expect.poll` over fixed sleeps.

## Writing browser tests

- Import `test` and `expect` from `tests/browser/fixtures/chrome.ts`. Its `chrome` fixture launches the installed Google Chrome headed with a fresh `--user-data-dir` and `--remote-debugging-port=0`, waits for `DevToolsActivePort`, exposes `port`, `wsPath`, `wsEndpoint`, `version`, and `pid`, and deletes the directory on teardown; `launchChrome()` starts extra instances.
- The fixture resolves Chrome from `RECNRUN_CHROME_PATH`, then `google-chrome` or `google-chrome-stable` on `PATH`, then the macOS app. Chrome runs as root in the container, so `--no-sandbox` is added only when `RECNRUN_TEST_CONTAINER=1`.
- `tests/browser/fixtures/fixture-app.ts` extends that `test` with `app`: it connects Playwright with `chromium.connectOverCDP(chrome.wsEndpoint)`, opens a fixture route with `app.open(route, query)`, and waits for `window.__fixture.ready`. `playwright.browser.config.ts` starts the fixture application on ports 4600 and 4601 ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md#fixture-application)).
- Every Docker run writes `versions.json` (Chrome, Node, pnpm, Playwright, image id). Report results as "Google Chrome <version> on Linux", never as validation of the default profile.
