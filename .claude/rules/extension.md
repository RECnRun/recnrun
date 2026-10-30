---
paths:
  - "apps/extension/**"
---

# Extension

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#extension) defines the layers and the security model. Key rules:

- **Thin entrypoints.** `src/entrypoints/*` only call a `start*` function from `src/background`, `src/content`, or `src/popup`. Logic lives in those folders, where unit tests reach it without WXT globals. Nothing imports an entrypoint.
- **Allowed origins.** `src/config/origins.ts` is the only list of pages the content script runs on and that may call the public API (`externally_connectable`). Production builds match only `https://recnrun.com/*` (the other project domains only redirect there); `development` and `test` builds add `localhost` and `127.0.0.1`. `recorderMatches` pre-grants `localhost` only in `test`, because WXT copies a runtime script's matches into `host_permissions`. `vp run test:extension-manifest` fails if a production manifest matches more, asks for permissions other than `storage`, `scripting`, `tabs`, and `tabGroups`, ships `host_permissions`, or lacks `key`.
- **Messaging.** The content script is a relay: it accepts bridge requests from its own page (`@recnrun/bridge` host), forwards them through `createRequester` (`src/messaging/request.ts`, shared with the popup), and returns the background's reply; it relays the `timeline` port's messages as bridge events. It never touches storage: dependency-cruiser rejects an import of `src/storage` or `wxt/utils/storage` from `src/content`, and lint rejects `browser.storage` there; a compromised page must not reach more than the background chooses to answer.
- **Recorder.** `src/recorder` runs inside the user's applications. It imports only `@recnrun/domain` and reports `{ kind: "step", step }`; it never answers the bridge or the public API (`extension-recorder-isolated`). Mask secrets at capture (password fields are `***`).
- **Validation.** The background validates every internal message with `BackgroundMessageSchema` and rejects senders other than its own extension id; public API messages go through `ExternalRequestSchema` (control types only) and `sender.url` is checked against the allowed origins. Payloads are validated against `REQUESTS` before dispatch. Stored data is validated with the domain schemas when read; invalid stored data is an error reply, never a partial result.
- **One controller.** Start, stop, resume, status, and grants live in `src/background/recording.ts` and `workflows.ts`, used by the popup, the website, and the public API alike through a `Caller` (the sender's tab, or the active tab for the popup). Do not add a second path.
- **Storage.** Workflows and steps live in IndexedDB through `src/storage/workflow-store.ts` (database `recnrun`, version `1`); a breaking change to a store bumps the version and migrates in `onupgradeneeded`. Small state, like the group → workflow bindings, uses WXT's `storage` (`wxt/utils/storage`) through a repository in `src/storage`; keys are `local:<name>`. Every read is validated.
- **Permissions.** Ask for no permission or host permission the current feature does not use. Adding one updates `apps/extension/scripts/manifest.checks.mjs` and the security model in the docs.
- **Imports.** WXT auto-imports are off (`imports: false`); import from `wxt/browser`, `wxt/utils/*`, and `@/` explicitly.
- **Tests.** Unit tests use `WxtVitest` and `fakeBrowser` (`wxt/testing/fake-browser`); reset it in `beforeEach`. `fakeBrowser` lacks `scripting`, `permissions`, and `tabGroups`, so the controller takes a `BrowserAdapter` and tests pass a fake; the store takes an `IDBFactory` and tests pass `fake-indexeddb`. Popup and recorder components run in Vitest Browser Mode. End-to-end tests load `.output/chrome-mv3-test`, built by `vp run extension#build:test`.
