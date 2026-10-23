# Architecture

[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) describes what the product does. This document fixes how the code is split and which way dependencies point. `.dependency-cruiser.cjs` enforces every boundary below (`vp run deps`); change both together.

```text
apps/website ──► @recnrun/bridge ──► valibot
     │            ▲                     ▲
     │      apps/extension ──► @recnrun/domain
     │            │
     └────────────┴──► @recnrun/brand (CSS and fonts)
```

## Packages

| Package           | Holds                                                                                                                                                        | May import                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `packages/domain` | Valibot schemas and inferred types for every concept; `Snapshot`, the versioned document the extension stores; `RecordingSession`, the recording in progress | `valibot` only                   |
| `packages/bridge` | The website ↔ content script protocol, its client, host, and `window` transport                                                                              | `valibot` only                   |
| `packages/brand`  | Mona Sans, and `base.css`: the palette, semantic tokens, and base layout both apps import first                                                              | nothing                          |
| `apps/website`    | The Preact SPA                                                                                                                                               | bridge, brand; never extension   |
| `apps/extension`  | The WXT extension                                                                                                                                            | every package; never the website |

- Packages never import apps. Apps never import each other: they meet only at the bridge protocol.
- Packages export their TypeScript sources (`exports` → `./src/index.ts`); apps bundle them. A package `build` only type checks.
- `@recnrun/brand` holds no code: it exports `base.css` (tokens and base layout) and `mona-sans.css`, which each app's entry imports before its own stylesheet, so the palette, the font, and its license exist once instead of once per app. It imports nothing (`brand-is-leaf`).
- `@recnrun/domain/testing` exports fixtures for tests; no `src/` file imports a test file.
- Every module is reachable from an entrypoint, a test, or a config (`no-orphans`), and there are no import cycles (`no-circular`).

## Website

```text
src/main.tsx ─► src/app ─► src/features/<name> ─► src/services ─► @recnrun/bridge
                   │              │
                   └──────────────┴──► src/ui
```

- `src/ui`: presentational components and pure helpers. It imports nothing from `features`, `services`, or `app`.
- `src/services/extension.ts`: the extension gateway, `createExtensionGateway()`, and the only module that imports `@recnrun/bridge`.
- `src/features/<name>`: state and views for one capability (`extension-status`). Features never import each other.
- `src/app`: composition. It picks the install banner or a short status from the extension state; when the extension is installed, its dashboard frame covers the site.
- `src/main.tsx`: mounts `App` with the real gateway. Nothing imports it.
- `privacy/index.html`: the privacy policy, a second build entry with no script. As its own file it gets status 200 on GitHub Pages at `/privacy/`, where a route served by `404.html` would get 404, and the Chrome Web Store listing links to it.

Components take the gateway or data as props, so component tests use a fake gateway.

## Extension

| Folder            | Runs in                    | Role                                                                                                                                            |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/entrypoints` | (WXT)                      | Thin wiring: each file calls one `start*` function. Nothing imports an entrypoint.                                                              |
| `src/content`     | The RECnRun website        | Bridge host, the frame that shows the dashboard over the site, and the PiP window the framed dashboard asks for.                                |
| `src/background`  | The service worker         | Validates requests and senders, answers them from storage; the triggers that open the session and the dashboard (`triggers.ts`).                |
| `src/storage`     | The service worker         | Repositories over WXT `storage` (`local:` for data, `session:` for the recording in progress); validates what it reads with the domain schemas. |
| `src/dashboard`   | The dashboard page         | Preact UI at `dashboard.html`: the recordings and the browser's tabs. Reads through functions it is given, never through content or background. |
| `src/session`     | The session page           | Preact UI at `session.html`: the one session's controls, in its Split View pane or a PiP window.                                                |
| `src/views`       | Dashboard and session      | The components and the recording hook both pages render, with their data injected.                                                              |
| `src/pip`         | Every page that floats one | Typed access to Document Picture-in-Picture and the window helpers ([POC 6](POCS.md#poc-6-record-opens-a-pip-window)).                          |
| `src/config`      | Build time                 | `origins.ts`: the pages the content script runs on and that may frame the extension's pages, per build mode.                                    |
| `src/messaging`   | Every extension page       | The content ↔ background, content ↔ frame, and page → background session message schemas; the Web Lock the views share.                         |

`content` never imports `storage`. `dashboard` and `session` never import each other, `content`, or `background`: the dashboard asks the background to start a session, and the session links to the dashboard by URL. `views` imports none of those, nor `storage`.

### Dashboard and session

The **dashboard** has no limit: any number of tabs, plus the frame over recnrun.com. It lists the recordings and every browser tab but the session's pane (`dashboard/open-tabs.ts`, kept current by the `tabs` events). With no session, each tab offers Record (the session splits beside it) and Float (the session opens in a PiP window over it). On the recorded tab it shows the status with Show, Pause or Resume, and Stop; other tabs offer nothing until the session ends. A dashboard tab can itself be recorded.

The **session** is one per profile, stored as `RecordingSession` (with the recorded `tabId`) in `storage.session`. It is rendered by `session.html` in one of two places: its pane, a tab in a Split View beside the recorded tab, or a PiP window. Typing its address shows "No recording is running" and a link to the dashboard. Stop ends the session and closes the pane and the PiP window; closing the recorded tab ends it too (`tabs.onRemoved`).

| Trigger                                                                                    | Does                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| The toolbar icon (no popup, so a click fires `action.onClicked`)                           | Records the tab with the session split beside it |
| The page's "Open RECnRun" context menu item (any page or frame Chrome adds items to)       | Same                                             |
| The `open-session` command (Alt+Shift+S)                                                   | Same                                             |
| A dashboard's Record or Show (an `open-session` runtime message)                           | Same, on the tab it names                        |
| A dashboard's Float (a `float-session` message, after the dashboard opened the PiP window) | Records the tab and activates it; no pane        |
| The `open-dashboard` command (Alt+Shift+D) or the icon's "Dashboard" context menu item     | Opens a new dashboard tab                        |
| The session pane's "Open the dashboard" link                                               | Opens a new dashboard tab; the session stays     |

`openSessionFrom` in `background/open-session.ts` places the pane (`placePane`). If the pane is already split with the tab, it is focused. Otherwise a tab in another Split View leaves it, and the pane is moved beside the tab (`tabs.unsplit`, `tabs.move`, `tabs.createSplit`) without a reload, so a running session retargets to the new tab and keeps its state; with no pane yet, `tabs.create({ splitWithTabId })` opens one. Without Split View, or when Chrome refuses the split, the pane opens as a tab next to the page. While the session floats in a PiP window, these triggers do nothing, so the window and the page it records stay where they are.

The background accepts session requests (`messaging/session-protocol.ts`) only from its own extension pages: `sender.id` must be its own and `sender.url` must start with its own origin, which rules out content scripts on recnrun.com.

From its pane, Float opens a PiP window from the pane's own click, portals the controls into it, and leaves the Split View so the page fills the window; closing the window without Stop splits the pane beside the page again (`session/session-tab.ts`). A dashboard tab floats the session by opening the PiP window from its own click and framing `session.html` inside it (`pip/document-pip.ts`, `showSession`). A frame cannot open a Document PiP window, so the framed dashboard posts `open-panel` and the content script opens the window from the site's page with the same frame. The framed session posts `close-panel` when it ends, and the window closes.

Views find each other through a Web Lock shared by the pages of one extension origin (`messaging/view-locks.ts`). A view with an open PiP window holds `recnrun-panel` and announces itself on a `BroadcastChannel` of the same name; watchers queue a shared request to learn when the lock frees, since exclusive waiters would take it from each other. While it is held, the dashboard shows "The session floats in its own window" instead of Show, and triggers are ignored.

A workspace is the origin a recording starts on, derived when the dashboard renders; nothing stores it. The dashboard keeps its route in the hash (`dashboard.html#/recordings/<id>`), since an extension page has no server to answer other paths.

On recnrun.com the content script covers the site with a full-viewport `<iframe>` of `dashboard.html` (`content/dashboard-frame.ts`), so the dashboard keeps the site's address. They sync the route over `postMessage` on the `recnrun-frame` channel (`messaging/frame-protocol.ts`): the frame starts at `?route=<site path>`, the content script sends a `route` message on Back and Forward, and the dashboard sends a `location` message (`path`, `title`) that the content script applies with `history.pushState` and `document.title`. Inside the frame, the dashboard's links point at the site's own URLs. Every view shares the recording through `storage.session` (POC 6E), not through frame messages. GitHub Pages answers unknown paths with `404.html`, so the website build copies `index.html` there (`apps/website/build/not-found-page.ts`) and deep links like `/recordings/<id>` load the site.

## Bridge protocol v1

The website and the content script share a window, so they talk through `window.postMessage`. Every message is an envelope `{ channel: "recnrun", protocol: 1, kind, ... }`:

| Kind       | Sender         | Fields                                              |
| ---------- | -------------- | --------------------------------------------------- |
| `announce` | content script | `extensionVersion`; sent once on start              |
| `request`  | website        | `id`, `type`                                        |
| `response` | content script | `id`, then `ok: true, result` or `ok: false, error` |

Request types and their result schemas live in `RESULT_SCHEMAS` (`packages/bridge/src/protocol.ts`):

| Type   | Result                 |
| ------ | ---------------------- |
| `ping` | `{ extensionVersion }` |

- **Detection.** `client.detect()` resolves `installed` on the first `announce` or `ping` reply, and `missing` after the timeout (1.5 s by default). Either signal is enough, so the order in which the page and the content script load does not matter.
- **Validation.** The host answers only valid requests of a known type. The client validates every result against its schema and rejects with `BridgeError` on a timeout, an error reply, or a malformed result.
- **Versioning.** `protocol` changes only for an incompatible envelope or message change; adding a request type does not change it. `getSnapshot` was removed while still at protocol 1, because no version had been released.

Inside the extension, the content script forwards `{ type }` with `browser.runtime.sendMessage`; the background replies `{ ok: true, result }` or `{ ok: false, error }`.

## Security model

The extension holds the user's data and is the only code that reads or shows it; the website only detects the extension.

- **Where the content script runs.** Production builds match only `https://recnrun.com/*`, where the website lives. The project also owns recnrun.app, recnrun.io, and recn.run; they only redirect to recnrun.com at the Cloudflare edge and never serve a page, so the extension does not match them. `development` and `test` builds add `http://localhost/*` and `http://127.0.0.1/*` (any port) for the dev server and end-to-end tests. Every build excludes `/privacy/*` on those origins (`exclude_matches`), so the dashboard frame never covers the privacy policy. `vp run test:extension-manifest` fails the build if a production manifest matches or excludes anything else.
- **Permissions.** Only `storage`, `contextMenus` (the "Dashboard" and "Open RECnRun" items), and `tabs`. `tabs` lets the dashboard list every tab's title and URL, and the background place the session's pane beside any tab; Chrome warns "Read your browsing history" at install. It runs no script in those tabs and grants no access to their pages. No host permissions, no `externally_connectable`, no access to other sites. The same check enforces it.
- **Who may frame the dashboard and the session.** `dashboard.html` and `session.html` are the only web-accessible resources, and only for the content script's own matches (`use_dynamic_url: false`, since the matches already scope them); any other page that frames them gets `ERR_BLOCKED_BY_CLIENT`. Pages may frame them regardless of their CSP. If any `location.ancestorOrigins` entry is not an allowed site, for example a page framing recnrun.com to clickjack it, either page renders only a refusal (`tests/e2e/dashboard-embedding.spec.ts`); the session page also allows its own origin, which a dashboard tab's PiP window has.
- **What the site sees of the frame.** The site cannot read the frame's document (`contentDocument` is `null`); it sees the frame's `src`, extension id included. Each side accepts frame messages only from the other's window and origin, validates them, and accepts only paths that start with `/`, so script on the site can navigate the dashboard but never read it. The content script opens a PiP window only for an `open-panel` from the dashboard frame, and closes it only for a `close-panel` from the session frame inside it.
- **Who may ask.** The `window` transport accepts only messages whose `source` is the page's own window and whose `origin` is the page's own origin, and replies only to that origin. Pages on other origins, other windows, and frames get no answer (`tests/e2e/origin-guard.spec.ts`).
- **What they can get.** Only the extension version: `ping` is the only request type, and no bridge message carries the user's data. The content script cannot read storage itself; it can only relay known request types to the background, which checks that the sender is its own extension.
- **What the dashboard trusts.** Stored data is validated when the extension reads it and rendered as text.
- **Script injection on recnrun.com** could navigate the dashboard frame or fake its content, so the website ships a strict CSP (`default-src 'self'`, no inline scripts or styles; `apps/website/build/content-security-policy.ts`). GitHub Pages sends no headers, so the CSP is a `<meta>` tag added to production builds only. Third-party scripts are not allowed on the website.
- Adding a write request widens this model; the `adding-a-bridge-message` skill requires documenting it here first.

### Recording (not built)

Recording in the user's own applications needs more than `storage`. Whatever M1 settles on follows these limits:

- **Per-origin access, granted at run time** (optional host permissions and `permissions.request`), or `activeTab` for a one-off page; `tabs` reveals URLs, not page access. No install-time host permissions, and never `<all_urls>`.
- Recording scripts in the user's applications never answer the bridge; they only report events to the background.
- `apps/extension/scripts/manifest.checks.mjs` changes in the same commit, so the production manifest allows exactly the new permissions.

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
- **dependency-cruiser and TypeScript 7.** dependency-cruiser 18 supports TypeScript below 7, so it parses with SWC (`parser: "swc"`, `@swc/core`); type-only imports are still detected. Its tsconfig-paths plugin resolves `paths` from the working directory, so each app has a `tsconfig.deps.json` repeating its `@/` alias from the repo root, and `vp run deps` cruises each app with its own.
- **WXT dev browser.** WXT 0.21 opens a browser only when its optional peer `web-ext` is installed; without it, `wxt` builds and asks you to load the extension by hand. `apps/extension` depends on `web-ext` for that reason. `wxt.config.ts` opens `http://localhost:5173/` (the website's fixed dev port) in a persistent profile under `.wxt/chrome-data`, which `vp run clean` deletes.
- **Knip and WXT.** Knip's WXT plugin expects `entrypoints/` at the package root; `knip.jsonc` lists `src/entrypoints` explicitly.
- **Extensions need a headed Chromium.** Playwright and Vitest Browser Mode run headed; Docker provides the display, so no window opens on the host.
