---
paths:
  - "apps/extension/**"
---

# Extension

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#extension) defines the layers and the security model. Key rules:

- **Thin entrypoints.** `src/entrypoints/*` only call a `start*` function from `src/background`, `src/content`, `src/dashboard`, or `src/session`. `src/tabs` is the one tab model (normal and incognito) and its event-driven source, read by the dashboard and the session; it imports no other app folder. Logic lives in those folders, where unit tests reach it without WXT globals. Nothing imports an entrypoint.
- **Allowed origins.** `src/config/origins.ts` is the only list of pages the content script runs on. Production builds match only `https://recnrun.com/*` (the other project domains only redirect there); `development` and `test` builds add `localhost` and `127.0.0.1`. `vp run test:extension-manifest` fails if a production manifest matches more, or asks for permissions other than `storage` and `tabs`, or declares commands or a popup, or sets `incognito` to anything but `spanning`. The same origins are the only ones that may frame `dashboard.html` and `session.html` (their `web_accessible_resources` matches) and the only ancestors those pages render under; with no ancestor they only point to the site.
- **Messaging.** The content script is a relay: it accepts bridge requests from its own page (`@recnrun/bridge` host), forwards them with `browser.runtime.sendMessage`, and returns the background's reply. It never imports `src/storage` (dependency-cruiser rejects it); a compromised page must not reach more than the background chooses to answer.
- **Validation.** The background validates every incoming message with `BackgroundRequestSchema`, rejects senders other than its own extension id, accepts `SessionRequestSchema` messages only from its own pages (never from a content script), and validates stored data with the domain schemas when reading it. Invalid stored data is an error reply, never a partial result.
- **Incognito.** Never store an incognito tab's title or URL, and never load its favicon URL from the extension (it would carry the normal context's cookies). To try it in the dev Chrome, turn on Developer mode before "Allow in Incognito": otherwise Chrome disables the unpacked extension when the toggle reloads it.
- **Storage.** Use WXT's `storage` (`wxt/utils/storage`) through a repository in `src/storage`; keys are `local:<name>`, or `session:<name>` for state that must end with the browser (the recording in progress). Change the stored shape only together with `SNAPSHOT_SCHEMA_VERSION` handling in `@recnrun/domain`.
- **Permissions.** Ask for no permission or host permission the current feature does not use. Adding one updates `apps/extension/scripts/manifest.checks.mjs` and the security model in the docs.
- **Imports.** WXT auto-imports are off (`imports: false`); import from `wxt/browser`, `wxt/utils/*`, and `@/` explicitly.
- **Tests.** Unit tests use `WxtVitest` and `fakeBrowser` (`wxt/testing/fake-browser`); reset it in `beforeEach`. Dashboard components run in Vitest Browser Mode. End-to-end tests load `.output/chrome-mv3-test`, built by `vp run extension#build:test`.
