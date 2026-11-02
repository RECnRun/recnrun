# Architecture

[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) describes what the product does. This document fixes how the code is split and which way dependencies point. `.dependency-cruiser.cjs` enforces every boundary below (`vp run deps`); change both together.

```text
apps/website ──► @recnrun/bridge ──► @recnrun/domain ──► valibot
apps/extension ─┘                    ▲
        └────────────────────────────┘

apps/website, apps/extension ──► @recnrun/brand (CSS and fonts)

apps/fixture: imports nothing from the workspace; only tests/ may import it
apps/isolator (POC) ──► isolation-core, worker-bootstrap, @recnrun/brand; nothing imports it
```

## Packages

| Package                   | Holds                                                                                                                                                                                           | May import                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/domain`         | Valibot schemas and inferred types for every concept; `Snapshot`, the versioned document the extension stores                                                                                   | `valibot` only                    |
| `packages/bridge`         | The website ↔ content script protocol, its client, host, and `window` transport                                                                                                                 | `@recnrun/domain`, `valibot`      |
| `packages/isolation-core` | Browser-agnostic logic of the namespaced-sessions POC (see [PLAN.md](poc/namespace-sessions/PLAN.md) section 5), and `vendor/splitsession/`, MIT-licensed SplitSession modules pinned by commit | `valibot` only (`src/`)           |
| `packages/brand`          | Brand assets both apps style themselves with: Mona Sans and the stylesheet that loads it                                                                                                        | nothing                           |
| `apps/website`            | The Preact SPA                                                                                                                                                                                  | all packages; never the extension |
| `apps/extension`          | The WXT extension                                                                                                                                                                               | all packages; never the website   |
| `apps/fixture`            | Development-only application under test for the namespaced-sessions POC; see its [README](../apps/fixture/README.md)                                                                            | Node built-ins only               |
| `apps/isolator`           | The namespaced-sessions POC extension (WXT, MV3); see [Isolator](#isolator-poc)                                                                                                                 | POC packages and brand only       |

- Packages never import apps. Apps never import each other: they meet only at the bridge protocol.
- Packages export their TypeScript sources (`exports` → `./src/index.ts`); apps bundle them. A package `build` only type checks.
- `@recnrun/brand` holds no code: it exports `mona-sans.css`, which each app's entry imports, so the font and its license exist once instead of once per app. It imports nothing (`brand-is-leaf`).
- `@recnrun/isolation-core` exists so the isolation logic (jar, DNR rules, namespace contract) stays free of extension APIs and testable on Node; this is why it is a package and not a folder of the extension (`isolation-core-pure`). `vendor/splitsession/` holds unmodified upstream files with `LICENSE`, `NOTICE`, and `vendor-manifest.json` (SHA-256 per file, checked by `tests/vendor.test.ts`); `src/` does not import `vendor/`, and Knip (as entries, until P2 imports them) and jscpd still scan the vendored files. Format and lint ignore `vendor/` because the files stay byte-identical, and `not-to-unresolvable` skips it because the files import siblings that are not vendored.
- `@recnrun/domain/testing` exports fixtures for tests; no `src/` file imports a test file.
- `apps/fixture` is the application the namespaced-sessions POC tests against ([PLAN.md §5](poc/namespace-sessions/PLAN.md#5-target-layout)). It must not share code with RECnRun, so it imports no workspace package (`fixture-isolated`), and only `tests/` may import it to start it (`only-tests-start-the-fixture`). Its served files and server modules are frozen by hash (`apps/fixture/freeze.json`).
- Every module is reachable from an entrypoint, a test, or a config (`no-orphans`), and there are no import cycles (`no-circular`).

## Website

```text
src/main.tsx ─► src/app ─► src/features/<name> ─► src/services ─► @recnrun/bridge
                   │              │
                   └──────────────┴──► src/ui
```

- `src/ui`: presentational components and pure helpers. It imports nothing from `features`, `services`, or `app`.
- `src/services/extension.ts`: the extension gateway, `createExtensionGateway()`, and the only module that imports `@recnrun/bridge`.
- `src/features/<name>`: state and views for one capability (`extension-status`, `explorer`). Features never import each other.
- `src/app`: composition. It picks the banner, the empty state, or the explorer from the extension state.
- `src/main.tsx`: mounts `App` with the real gateway. Nothing imports it.

Components take the gateway or data as props, so component tests use a fake gateway.

## Extension

| Folder            | Runs in                | Role                                                                                       |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `src/entrypoints` | (WXT)                  | Thin wiring: each file calls one `start*` function. Nothing imports an entrypoint.         |
| `src/content`     | The RECnRun website    | Bridge host. Relays known requests to the background and returns its reply.                |
| `src/background`  | The service worker     | Validates requests and senders, answers them from storage.                                 |
| `src/storage`     | The service worker     | Repositories over WXT `storage`; validates what it reads with the domain schemas.          |
| `src/popup`       | The toolbar popup      | Preact UI. Reads through a function it is given, never through content or background code. |
| `src/config`      | Build time             | `origins.ts`: the pages the content script runs on, per build mode.                        |
| `src/messaging`   | Content and background | The internal content ↔ background message schema.                                          |

`content` never imports `storage`, and `popup` never imports `content` or `background`.

## Isolator (POC)

`apps/isolator` is the runtime of the namespaced-sessions proof of concept on branch `poc-namespace-sessions` ([PLAN.md §5](poc/namespace-sessions/PLAN.md#5-target-layout)). It is separate from the recording product: it may import only `packages/isolation-core`, `packages/worker-bootstrap` (both added by later POC tasks), and `@recnrun/brand` (`isolator-only-poc-packages`), never `apps/extension` or `apps/website` (`isolator-not-to-recording-apps`), and nothing imports it (`nothing-to-isolator`): tests load its build output, `apps/isolator/.output/chrome-mv3-test` (`vp run @recnrun/isolator#build:test`, run by `test:browser:local` and `test:experiments:local`). Its entrypoints are thin like the extension's; `src/background` records a `chrome.storage.session` marker on install and startup and answers its own `getSelf` message with `chrome.management.getSelf()`. Permissions are `storage` and `management` until P0.4 adds `debugger`. `vp run dev:isolator` builds it in watch mode; without `web-ext` WXT opens no browser, so load it by hand (MANUAL_VALIDATION.md M-P0.a).

## Bridge protocol v1

The website and the content script share a window, so they talk through `window.postMessage`. Every message is an envelope `{ channel: "recnrun", protocol: 1, kind, ... }`:

| Kind       | Sender         | Fields                                              |
| ---------- | -------------- | --------------------------------------------------- |
| `announce` | content script | `extensionVersion`; sent once on start              |
| `request`  | website        | `id`, `type`                                        |
| `response` | content script | `id`, then `ok: true, result` or `ok: false, error` |

Request types and their result schemas live in `RESULT_SCHEMAS` (`packages/bridge/src/protocol.ts`):

| Type          | Result                 |
| ------------- | ---------------------- |
| `ping`        | `{ extensionVersion }` |
| `getSnapshot` | `Snapshot`             |

- **Detection.** `client.detect()` resolves `installed` on the first `announce` or `ping` reply, and `missing` after the timeout (1.5 s by default). Either signal is enough, so the order in which the page and the content script load does not matter.
- **Validation.** The host answers only valid requests of a known type. The client validates every result against its schema and rejects with `BridgeError` on a timeout, an error reply, or a malformed result.
- **Versioning.** `protocol` changes only for an incompatible envelope or message change; adding a request type does not change it.

Inside the extension, the content script forwards `{ type }` with `browser.runtime.sendMessage`; the background replies `{ ok: true, result }` or `{ ok: false, error }`.

## Security model

The extension holds the user's data; the website only displays it.

- **Where the content script runs.** Production builds match only `https://recnrun.com/*`, where the website lives. The project also owns recnrun.app, recnrun.io, and recn.run; they only redirect to recnrun.com at the Cloudflare edge and never serve a page, so the extension does not match them. `development` and `test` builds add `http://localhost/*` and `http://127.0.0.1/*` (any port) for the dev server and end-to-end tests. `vp run test:extension-manifest` fails the build if a production manifest matches anything else.
- **Permissions.** Only `storage`: no host permissions, no `externally_connectable`, no access to other sites. The same check enforces it.
- **Who may ask.** The `window` transport accepts only messages whose `source` is the page's own window and whose `origin` is the page's own origin, and replies only to that origin. Pages on other origins, other windows, and frames get no answer (`tests/e2e/origin-guard.spec.ts`).
- **What they can get.** The bridge is read-only. The content script cannot read storage itself; it can only relay known request types to the background, which checks that the sender is its own extension.
- **What the website trusts.** Stored data is validated when the extension reads it and again when the website receives it. Data is rendered as text.
- **Script injection on recnrun.com** would let an attacker read the user's data through the bridge, so the website ships a strict CSP (`default-src 'self'`, no inline scripts or styles; `apps/website/build/content-security-policy.ts`). GitHub Pages sends no headers, so the CSP is a `<meta>` tag added to production builds only. Third-party scripts are not allowed on the website.
- Adding a write request widens this model; the `adding-a-bridge-message` skill requires documenting it here first.

### Recording (not built)

Recording in the user's own applications needs more than `storage`. Whatever M1 settles on follows these limits:

- **Per-origin access, granted at run time** (optional host permissions and `permissions.request`), or `activeTab` for a one-off page. No install-time host permissions, and never `<all_urls>`.
- Recording scripts in the user's applications never answer the bridge; they only report events to the background.
- `apps/extension/scripts/manifest.checks.mjs` changes in the same commit, so the production manifest allows exactly the new permissions.

## Toolchain

| Concern                  | Tool                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Package manager, tasks   | Vite+ (`vp`) with pnpm workspaces and a version catalog                            |
| Format, lint, type check | `vp check`: Oxfmt, Oxlint (type aware, with `eslint-plugin-sonarjs`), tsgo         |
| Architecture boundaries  | dependency-cruiser (`.dependency-cruiser.cjs`)                                     |
| Dead code, duplication   | Knip (`knip.jsonc`), jscpd                                                         |
| Documentation            | `scripts/check-docs.mjs` (`vp run docs:check`): relative links and anchors resolve |
| Unit and component tests | Vitest with V8 coverage; Vitest Browser Mode with Playwright Chromium              |
| End-to-end               | Playwright, headed Chromium with the test extension, in Docker on Xvfb             |
| Browser and experiments  | Playwright `connectOverCDP` to Google Chrome Stable, headed on Xvfb                |
| Extension build          | WXT with `@preact/preset-vite`                                                     |

Findings from the bootstrap spike, kept here because they explain the configuration:

- **WXT on Vite+.** The workspace overrides `vite` with `@voidzero-dev/vite-plus-core`; WXT 0.21 builds on it unchanged. `import.meta.env.MODE` is available in `defineContentScript` options, which is how `origins.ts` varies matches per build mode.
- **WXT tests.** `vitest.config.ts` passes its own `root` to `WxtVitest`; without it, Vitest projects started from the repo root cannot resolve the `@/` alias. `.wxt/` is generated by `wxt prepare` (the root `prepare` script, and explicitly in `Dockerfile.tests`, because pnpm skips `prepare` when `node_modules` is current).
- **dependency-cruiser and TypeScript 7.** dependency-cruiser 18 supports TypeScript below 7, so it parses with SWC (`parser: "swc"`, `@swc/core`); type-only imports are still detected. Its tsconfig-paths plugin resolves `paths` from the working directory, so each app has a `tsconfig.deps.json` repeating its `@/` alias from the repo root, and `vp run deps` cruises each app with its own. npm packages are not followed but stay in the graph as leaves, so rules can name them (`not-to-dev-dep`, `extension-content-not-to-storage`); the `exclude` names only the workspaces' build output, since a pattern on `dist/` would also drop every package's own `dist/`.
- **WXT dev browser.** WXT 0.21 opens a browser only when its optional peer `web-ext` is installed; without it, `wxt` builds and asks you to load the extension by hand. `apps/extension` depends on `web-ext` for that reason. `wxt.config.ts` opens `http://localhost:5173/` (the website's fixed dev port) in a persistent profile under `.wxt/chrome-data`, which `vp run clean` deletes.
- **Knip and WXT.** Knip's WXT plugin expects `entrypoints/` at the package root; `knip.jsonc` lists `src/entrypoints` explicitly.
- **Extensions need a headed Chromium.** Playwright and Vitest Browser Mode run headed; Docker provides the display, so no window opens on the host.
- **Google Chrome in Docker.** `Dockerfile.tests` installs `google-chrome-stable` from Google's apt repository in its `runtime` stage and writes `/opt/recnrun/versions.json`, which `scripts/test-container.mjs` copies with the image id into each run's `.artifacts/docker/<run-id>/versions.json`. `tests/container/runner.checks.mjs` builds that stage alone (cached) and checks `google-chrome --version` reports 144 or later. Chrome runs as root in the container, where its sandbox cannot start, so `tests/browser/fixtures/chrome.ts` adds `--no-sandbox` there and only there.
