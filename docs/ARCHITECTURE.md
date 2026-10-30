# Architecture

[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) describes what the product does. This document fixes how the code is split and which way dependencies point. `.dependency-cruiser.cjs` enforces every boundary below (`vp run deps`); change both together.

```text
apps/website ──► @recnrun/bridge ──► @recnrun/domain ──► valibot
apps/extension ─┘                    ▲
        └────────────────────────────┘

apps/website, apps/extension ──► @recnrun/brand (CSS and fonts)
```

## Packages

| Package           | Holds                                                                                                             | May import                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/domain` | Valibot schemas and inferred types for every concept: `Workflow`, `Tag`, `Step`, `RecordingStatus`, `StartResult` | `valibot` only                    |
| `packages/bridge` | The website ↔ content script protocol, its client, host, and `window` transport                                   | `@recnrun/domain`, `valibot`      |
| `packages/brand`  | Brand assets both apps style themselves with: Mona Sans and the stylesheet that loads it                          | nothing                           |
| `apps/website`    | The Preact SPA                                                                                                    | all packages; never the extension |
| `apps/extension`  | The WXT extension                                                                                                 | all packages; never the website   |

- Packages never import apps. Apps never import each other: they meet only at the bridge protocol.
- Packages export their TypeScript sources (`exports` → `./src/index.ts`); apps bundle them. A package `build` only type checks.
- `@recnrun/brand` holds no code: it exports `mona-sans.css`, which each app's entry imports, so the font and its license exist once instead of once per app. It imports nothing (`brand-is-leaf`).
- `@recnrun/domain/testing` exports fixtures for tests; no `src/` file imports a test file.
- Every module is reachable from an entrypoint, a test, or a config (`no-orphans`), and there are no import cycles (`no-circular`).

## Website

```text
src/main.tsx ─► src/app ─► src/features/<name> ─► src/services ─► @recnrun/bridge
                   │              │
                   └──────────────┴──► src/ui
```

- `src/ui`: presentational components and pure helpers. It imports nothing from `features`, `services`, or `app`.
- `src/services/extension.ts`: the extension gateway, `createExtensionGateway()`, and the only module that imports `@recnrun/bridge`. It exposes one method per request type and one subscription per event.
- `src/features/<name>`: state and views for one capability: `extension-status` (detection), `recording-status` (the visitor's group, with the **Allow access** button), `workflows` (list, filter, delete), `timeline` (the steps of one workflow, live). Features never import each other.
- `src/app`: composition. `route.ts` parses the hash (`#/` and `#/workflows/:id`); `App.tsx` picks the banner or the page from the extension state.
- `src/main.tsx`: mounts `App` with the real gateway. Nothing imports it.

Components take the gateway or data as props, so component tests use a fake gateway.

## Extension

| Folder            | Runs in                    | Role                                                                                                                                                                       |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/entrypoints` | (WXT)                      | Thin wiring: each file calls one `start*` function. Nothing imports an entrypoint.                                                                                         |
| `src/content`     | The RECnRun website        | Bridge host. Relays known requests to the background and turns the `timeline` port's messages into bridge events, reconnecting when the service worker drops it.           |
| `src/recorder`    | The user's applications    | Observes DOM events, builds a selector, and reports a `StepDraft` to the background. Imports nothing from the other folders or the bridge (`extension-recorder-isolated`). |
| `src/background`  | The service worker         | Validates messages and senders, runs the workflow controller (`recording.ts`, `workflows.ts`, `tab-groups.ts`), and pushes events through `timeline-ports.ts`.             |
| `src/storage`     | The service worker         | `workflow-store.ts`: workflows and steps in IndexedDB. `recordings-repository.ts`: the group → workflow bindings in WXT `storage`. Both validate what they read.           |
| `src/popup`       | The toolbar popup          | Preact UI. Sends requests through a function it is given, never through content or background code.                                                                        |
| `src/config`      | Build time                 | `origins.ts`: content script, public API, and pre-granted recorder origins per build mode; `key.ts`: the public key that fixes the extension id.                           |
| `src/messaging`   | Content, popup, background | The internal message schemas and `createRequester`, the typed sender the content script and the popup share.                                                               |

`content` never imports `storage`, `recorder` imports only the domain, and `popup` never imports `content` or `background`.

### Recording

One controller in the background serves every caller. The popup, the content script (for the website), and the public API all reach it through the same dispatcher with a **caller**: the sender's tab, and for the website the dashboard origin.

- **Scope.** A recording binds a tab group to a workflow. `start` groups the caller's tab when it is not in a group (title "RECnRun"), opens `payload.url` in that group when given, then checks that every tab's origin is granted. `stop` and `resume` work on the caller's group, or on the workflow id they are given. `tabGroups.onRemoved` stops the group's workflow.
- **Caller's tab.** Messages from the popup carry no tab (`sender.url` starts with `chrome-extension://`, even when the popup is open in a tab), so the controller uses the active tab of the last focused window.
- **Site access.** The pattern for a page is `scheme://host/*`, so `localhost` is one grant for every port. The controller asks `permissions.contains` and returns `permission-required` with the missing patterns; `grantOrigins` calls `permissions.request`, which Chrome accepts only inside a user gesture, so only the popup's and the dashboard's **Allow access** buttons send it.
- **Recorder injection.** While any group records, `scripting.registerContentScripts` registers `recorder.js` for every granted origin, and `executeScript` injects it into the recording group's loaded tabs; when nothing records, the script is unregistered. `onInstalled` and `onStartup` re-sync. The test build pre-grants `localhost` through `host_permissions`, because Playwright cannot accept Chrome's prompt; WXT 0.21 copies a runtime-registered script's `matches` into `host_permissions`, which is why `recorderMatches` returns `[]` outside `test`.
- **Steps.** The recorder sends `{ kind: "step", step }`; the background accepts it only from its own extension, from a tab in a recording group, and not from the recording's dashboard origin, then adds `id`, `workflowId`, and `tabId`, stores it, and pushes it. `tabs.onUpdated` with a new URL adds a `navigate` step by `browser`, and reports newly missing origins.
- **Push.** The content script opens a `runtime.Port` named `timeline`. `stepRecorded` goes to every port; `recordingChanged` only to ports whose tab is in the affected group, looked up when the event fires so a dashboard that joins a group later still hears it; `workflowChanged` goes to every port.

## Bridge protocol v1

The website and the content script share a window, so they talk through `window.postMessage`. Every message is an envelope `{ channel: "recnrun", protocol: 1, kind, ... }`:

| Kind       | Sender         | Fields                                              |
| ---------- | -------------- | --------------------------------------------------- |
| `announce` | content script | `extensionVersion`; sent once on start              |
| `request`  | website        | `id`, `type`, `payload?`                            |
| `response` | content script | `id`, then `ok: true, result` or `ok: false, error` |
| `event`    | content script | `name`, `data`; pushed, never answered              |

Request types, their payload and result schemas live in `REQUESTS` (`packages/bridge/src/protocol.ts`); events in `EVENTS`:

| Type                 | Payload                               | Result                    | Public API |
| -------------------- | ------------------------------------- | ------------------------- | ---------- |
| `ping`               | none                                  | `{ extensionVersion }`    | no         |
| `getRecordingStatus` | none                                  | `RecordingStatus`         | yes        |
| `startWorkflow`      | `{ title, description?, tags, url? }` | `StartResult`             | yes        |
| `stopWorkflow`       | `{ id? }`                             | `Workflow`                | yes        |
| `resumeWorkflow`     | `{ id }`                              | `StartResult`             | yes        |
| `grantOrigins`       | `{ origins }`                         | `{ granted }`             | no         |
| `listWorkflows`      | none                                  | `Workflow[]` newest first | no         |
| `listSteps`          | `{ workflowId }`                      | `Step[]` oldest first     | no         |
| `deleteWorkflow`     | `{ id }`                              | `{ deleted: true }`       | no         |

| Event              | Data              | When                                                       |
| ------------------ | ----------------- | ---------------------------------------------------------- |
| `stepRecorded`     | `Step`            | A step was stored                                          |
| `workflowChanged`  | `Workflow`        | A workflow was created, stopped, or resumed                |
| `recordingChanged` | `RecordingStatus` | The page's own tab group started, stopped, or needs access |

- **Detection.** `client.detect()` resolves `installed` on the first `announce` or `ping` reply, and `missing` after the timeout (1.5 s by default). Either signal is enough, so the order in which the page and the content script load does not matter.
- **Validation.** The host validates the payload and answers only valid requests of a known type. The client validates every result against its schema and rejects with `BridgeError` on a timeout, an error reply, or a malformed result; it drops events whose data does not match.
- **Versioning.** `protocol` changes only for an incompatible envelope or message change; adding a request type, a payload field, or an event does not change it.

Inside the extension, the content script and the popup send `{ kind: "request", type, payload }` with `browser.runtime.sendMessage`; the background replies `{ ok: true, result }` or `{ ok: false, error }`, and `createRequester` validates both the reply and the result.

### Public API

Pages on the origins in `externally_connectable.matches` (the same list as the content script: `https://recnrun.com/*`, plus `localhost` and `127.0.0.1` in `development` and `test`) can call the extension directly:

```js
await chrome.runtime.sendMessage("diabhlabffpmdllbkikfpnekcfndipao", {
  kind: "request",
  type: "startWorkflow",
  payload: { title: "Log in as admin", tags: ["env:local"], url: "http://localhost:4200/login" },
});
```

The id is fixed by `manifest.key`, so the unpacked and the store builds share it and the `recording-a-workflow` skill hardcodes it. The private key is not in the repository. The background's `onMessageExternal` listener validates the message with `ExternalRequestSchema` (the four control types above, nothing else), checks `sender.url` against the allowed origins of the build, and requires `sender.tab`, from which the caller's group comes. Other extensions can be allowed later through `externally_connectable.ids`.

## Security model

The extension holds the user's data; the website displays it and, with the popup, controls recording.

- **Where the content script runs.** Production builds match only `https://recnrun.com/*`, where the website lives. The project also owns recnrun.app, recnrun.io, and recn.run; they only redirect to recnrun.com at the Cloudflare edge and never serve a page, so the extension does not match them. `development` and `test` builds add `http://localhost/*` and `http://127.0.0.1/*` (any port) for the dev server and end-to-end tests. `vp run test:extension-manifest` fails the build if a production manifest matches anything else, in the content script or in `externally_connectable`.
- **Permissions.** `storage`, `scripting` (to register and inject the recorder), `tabs` (to read the URL and group of tabs on origins not yet granted, so the extension can name the origin to allow), and `tabGroups` (to create the "RECnRun" group and stop when a group closes). `tabs` adds Chrome's "read your browsing history" install warning; that is the price of naming origins before access is granted. Site access is only `optional_host_permissions` (`http://*/*`, `https://*/*`), granted per origin at run time from a user click; the production manifest has no `host_permissions`. The same check enforces all of it.
- **Who may ask.** The `window` transport accepts only messages whose `source` is the page's own window and whose `origin` is the page's own origin, and replies only to that origin. Pages on other origins, other windows, and frames get no answer (`tests/e2e/origin-guard.spec.ts`). The public API answers only pages whose `sender.url` is on the allowed origins (`tests/e2e/workflows.spec.ts`).
- **What they can do.** Any script on recnrun.com (or the visitor's own extension popup) can start, stop, and resume recordings and delete workflows; the CSP below is what keeps such scripts out. The public API exposes control only: reading steps and granting access stay on the bridge, and granting access still needs Chrome's prompt after a click. The content script cannot read storage itself; it can only relay known request types to the background, which checks that the sender is its own extension.
- **What is recorded.** The recorder runs only on granted origins while a group records, reports to the background only, and never answers the bridge or the public API. Password fields are masked at capture, because `listSteps` exposes typed values. Events from the dashboard tab are dropped.
- **What the website trusts.** Stored data is validated when the extension reads it and again when the website receives it. Data is rendered as text.
- **Script injection on recnrun.com** would let an attacker read the user's steps and drive recordings through the bridge, so the website ships a strict CSP (`default-src 'self'`, no inline scripts or styles; `apps/website/build/content-security-policy.ts`). GitHub Pages sends no headers, so the CSP is a `<meta>` tag added to production builds only. Third-party scripts are not allowed on the website.
- Adding a request widens this model; the `adding-a-bridge-message` skill requires documenting it here first. Adding a permission updates `apps/extension/scripts/manifest.checks.mjs` in the same commit.

## Toolchain

| Concern                  | Tool                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| Package manager, tasks   | Vite+ (`vp`) with pnpm workspaces and a version catalog                    |
| Format, lint, type check | `vp check`: Oxfmt, Oxlint (type aware, with `eslint-plugin-sonarjs`), tsgo |
| Architecture boundaries  | dependency-cruiser (`.dependency-cruiser.cjs`)                             |
| Dead code, duplication   | Knip (`knip.jsonc`), jscpd                                                 |
| Unit and component tests | Vitest with V8 coverage; Vitest Browser Mode with Playwright Chromium      |
| End-to-end               | Playwright, headed Chromium with the test extension, in Docker on Xvfb     |
| Extension build          | WXT with `@preact/preset-vite`                                             |

Findings from the bootstrap spike, kept here because they explain the configuration:

- **WXT on Vite+.** The workspace overrides `vite` with `@voidzero-dev/vite-plus-core`; WXT 0.21 builds on it unchanged. `import.meta.env.MODE` is available in `defineContentScript` options, which is how `origins.ts` varies matches per build mode.
- **WXT tests.** `vitest.config.ts` passes its own `root` to `WxtVitest`; without it, Vitest projects started from the repo root cannot resolve the `@/` alias. `.wxt/` is generated by `wxt prepare` (the root `prepare` script, and explicitly in `Dockerfile.tests`, because pnpm skips `prepare` when `node_modules` is current).
- **dependency-cruiser and TypeScript 7.** dependency-cruiser 18 supports TypeScript below 7, so it parses with SWC (`parser: "swc"`, `@swc/core`); type-only imports are still detected. Its tsconfig-paths plugin resolves `paths` from the working directory, so each app has a `tsconfig.deps.json` repeating its `@/` alias from the repo root, and `vp run deps` cruises each app with its own. npm packages are not followed but stay in the graph as leaves, so rules can name them (`not-to-dev-dep`, `extension-content-not-to-storage`); the `exclude` names only the workspaces' build output, since a pattern on `dist/` would also drop every package's own `dist/`.
- **WXT dev browser.** WXT 0.21 opens a browser only when its optional peer `web-ext` is installed; without it, `wxt` builds and asks you to load the extension by hand. `apps/extension` depends on `web-ext` for that reason. `wxt.config.ts` opens `http://localhost:5173/` (the website's fixed dev port) in a persistent profile under `.wxt/chrome-data`, which `vp run clean` deletes.
- **Knip and WXT.** Knip's WXT plugin expects `entrypoints/` at the package root; `knip.jsonc` lists `src/entrypoints` explicitly.
- **Extensions need a headed Chromium.** Playwright and Vitest Browser Mode run headed; Docker provides the display, so no window opens on the host.
- **Runtime-registered scripts and host permissions.** WXT 0.21 copies the `matches` of a `registration: "runtime"` content script into the manifest's `host_permissions`. The recorder's matches therefore come from `recorderMatches(mode)`, which is empty except in the `test` build, and the origins it really runs on are decided at run time with `scripting.registerContentScripts`.
- **The popup in a tab.** Playwright cannot open the toolbar popup, so the end-to-end test opens `chrome-extension://<id>/popup.html` in a tab. The background treats any sender whose URL starts with `chrome-extension://` as the popup, with no tab of its own, so the active tab is used either way.
- **IndexedDB in tests.** `workflow-store.ts` takes an `IDBFactory`; unit tests pass `fake-indexeddb`.
