# Architecture

[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) describes what the product does. This document fixes how the code is split and which way dependencies point. `.dependency-cruiser.cjs` enforces every boundary below (`vp run deps`); change both together. The decisions behind it are [ADR 0001](adr/0001-local-service-over-cdp.md) and [ADR 0002](adr/0002-retire-extension-and-bridge.md).

## Target layout

The layout of [PLAN.md §4](plan/PLAN.md#4-target-layout). Workspaces stay `apps/*` and `packages/*`; arrows are allowed imports.

```text
apps/cli ──► apps/service ──► packages/engine ──► packages/protocol ──► valibot
   │              │              │    ▲
   │              │              ▼    │
   │              ├──► packages/adapter ──► playwright-core, CDP
   │              └──► packages/persistence ──► node:sqlite, node:fs
apps/ui ──► packages/protocol (types and schemas only), @recnrun/brand
apps/website ──► @recnrun/brand (landing and install guide; no engine code)
apps/fixture: the controllable test application; nothing imports it
```

| Workspace              | Holds                                                                                                                                      | May import                                                                                                            | Since |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/protocol`    | Versioned schemas: flow DSL, locator lists, event envelope, run manifest, summary and coverage, capability matrix, service API, MCP shapes | `valibot`                                                                                                             | F0.2  |
| `packages/engine`      | Sessions, leases, steps, locator resolution, recorder normalization, function registry, macro runtime                                      | `protocol`                                                                                                            | F0.2  |
| `packages/adapter`     | Chrome discovery, the CDP connection, targets and frames, actions, instrumentation hooks, element references                               | `engine` (the adapter interface), `protocol`, `playwright-core`, `valibot`, four `node:` builtins ([below](#adapter)) | F0.2  |
| `packages/persistence` | Flow folders, revisions, the JSONL journal, blobs by hash, the SQLite index, export and import, [bindings](#profile-bindings)              | `protocol`, `node:` builtins                                                                                          | F0.2  |
| `packages/brand`       | The Mona Sans font and the stylesheet every app imports                                                                                    | nothing                                                                                                               | M0    |
| `apps/service`         | The loopback HTTP and WebSocket API, locks, lifecycle, logs, the MCP stdio adapter; serves the built UI                                    | `engine`, `adapter`, `persistence`, `protocol`                                                                        | F0.2  |
| `apps/ui`              | The Preact SPA on localhost: catalog, recorder, editor, run, diagnostics                                                                   | `protocol`, `brand`, `preact`                                                                                         | F0.2  |
| `apps/cli`             | `setup`, `open`, `run`, `doctor`, `agents setup`, `mcp`; published as `@recnrun/cli`                                                       | `service`                                                                                                             | F0.2  |
| `apps/fixture`         | The controllable test application: pages on two ports, `?fail=<case>`, `window.__fixture` ([below](#fixture-application))                  | nothing from the workspace; `node:` builtins                                                                          | F0.2  |
| `apps/website`         | The public landing at recnrun.com and the install guide                                                                                    | `brand`                                                                                                               | M0    |

- The engine never imports Playwright or CDP types. It defines the adapter interface (`BrowserAdapter`); `packages/adapter` imports that interface from `engine` and implements it, and `engine` never imports the adapter. The service wires the two together, so unit tests use a fake adapter and browser tests use the real one.
- Packages never import apps. Apps meet through `packages/protocol` and the service API; the only app that imports another is `apps/cli`, which starts `apps/service`.
- Packages export their TypeScript sources (`exports` → `./src/index.ts`); apps bundle them. A package `build` only type checks, and so do the Node apps (`service`, `cli`, `fixture`) until F7 bundles the CLI; `apps/ui` builds with Vite.
- `@recnrun/brand` holds no code: it exports `mona-sans.css`, which each app's entry imports, so the font and its license exist once. It imports nothing (`brand-is-leaf`).
- Every module is reachable from an entrypoint, a test, or a config (`no-orphans`), and there are no import cycles (`no-circular`).

Each workspace has one dependency-cruiser rule that lists what its `src` may import; anything else is a violation:

| Rule                         | From                   | Allowed targets                                                                                                    |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `protocol-pure`              | `packages/protocol`    | itself, `valibot`                                                                                                  |
| `engine-not-to-adapter-impl` | `packages/engine`      | itself, `protocol` (no adapter, Playwright, CDP, or Node APIs)                                                     |
| `adapter-boundaries`         | `packages/adapter`     | itself, `engine`, `protocol`, `playwright-core`, `valibot`, `node:fs/promises`, `node:net`, `node:os`, `node:path` |
| `persistence-boundaries`     | `packages/persistence` | itself, `protocol`, `node:` builtins                                                                               |
| `service-boundaries`         | `apps/service`         | itself, `engine`, `adapter`, `persistence`, `protocol`                                                             |
| `cli-only-service`           | `apps/cli`             | itself, `apps/service`                                                                                             |
| `ui-only-protocol`           | `apps/ui`              | itself, `protocol`, `brand`, `preact`                                                                              |
| `fixture-isolated`           | `apps/fixture`         | nothing from `apps/` or `packages/`                                                                                |
| `website-only-brand`         | `apps/website`         | `brand` among the workspace packages                                                                               |

A later task that needs a new import (for example `node:http` in the service) widens that workspace's rule and this table in the same change, with the reason. `src/main.tsx` and `src/bin.ts` of any app are entrypoints that nothing imports (`not-to-entrypoints`).

## Protocol

`packages/protocol/src` holds one module per concept; `index.ts` re-exports them.

| Module                                             | Shapes                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `flow.ts`, `steps.ts`, `actions.ts`, `locators.ts` | The flow DSL: actors, inputs, requirements, preconditions, action, assertion, and builtin steps, targets                             |
| `interpolation.ts`                                 | `${env.*}`, `${inputs.*}`, `${vars.*}`, `${locals.*}`, and `${secrets.*}`; any other namespace is rejected                           |
| `validate.ts`                                      | `validateFlow(input)`: the schema plus the cross-step checks, as `{ ok: true, flow }` or `{ ok: false, issues }`                     |
| `discovery.ts`                                     | `DiscoveryResultSchema`: the endpoint found in `DevToolsActivePort`, or a failure code with its remedy; Chrome channels              |
| `events.ts`                                        | The event envelope of the journal (source plan §11), the gap record, and the adapter events (`connection.lost`, `control.contested`) |
| `connection.ts`                                    | The browser handshake (`Browser.getVersion` and the domain probe), CDP targets, the connection source, and the reconnect result      |
| `instrumentation.ts`                               | The observer binding name, the hook version, observer messages (`document.hook-installed`), instrumentation events, and the report   |
| `run.ts`                                           | `manifest.json`, `steps.json`, `coverage.json`, and `summary.json` of a run, with the exit code of each status                       |
| `states.ts`                                        | Session, control, and step states and their legal transitions (source plan §6)                                                       |
| `capabilities.ts`                                  | Capture surfaces, statuses, and the capability matrix                                                                                |
| `api.ts`, `api-commands.ts`                        | The request and response envelopes, error codes, and the params and result of every command (`SERVICE_COMMANDS`)                     |
| `bindings.ts`                                      | Profile bindings, `bindings.json`, a binding's status (`fresh`, `stale-restarted`, `stale-missing`), and `parseBindingsFile`         |

The `if` block names its branches `steps` and `otherwise`, never `then`/`else`: an object with a `then` property is a thenable, so `await` or `return` in async code would treat a parsed step as a promise. The source plan's §9.3 example is adapted that way, with a comment in its fixture.

Each issue of `validateFlow` has a `code` (`unknown-action`, `unknown-namespace`, `duplicate-step-id`, `missing-input`, `cyclic-variable`, `nth-without-index`, and others in `FLOW_ISSUE_CODES`) and the `path` of the offending key from the flow's root.

The capability matrix lives in code (`capability-matrix.ts`, fed by `capability-surfaces.ts`, `capability-features.ts`, and `capability-roadmap.ts`). `vp run capabilities:generate` renders it to [CAPABILITIES.md](CAPABILITIES.md), and `vp run docs:check` fails when that file is stale. A capability status moves only with a test that shows the new behavior.

`vp run schema:generate` writes JSON Schema for the flow, the event, the adapter events, the discovery result, the browser handshake, the bindings file, the instrumentation event, report, and observer message, the run files, the capability matrix, and the service envelopes to `packages/protocol/schema/*.json` through `@valibot/to-json-schema`, and the files are committed. `tests/schema-drift.test.ts` fails when a schema changes without regenerating them. JSON Schema describes structure only: rules written as `v.check` (known interpolation namespaces, `nth` needs an index, the exit code matches the status) and the cross-step checks of `validateFlow` are enforced by the protocol code, not by the exported files. Only `src` must stay pure; `scripts/` and `tests/` use Node APIs to write and read those files.

## Adapter

`packages/adapter` is the only package that imports `playwright-core` or speaks CDP. `createCdpAdapter()` (`src/adapter.ts`) implements the engine's `BrowserAdapter` interface: `discover`, `connect`, `listTargets`, `reconnect`, `disconnect`, `onEvent`, and `describeProfile`, over one connection at a time.

- **Discovery** (`src/discovery.ts`, F1.1). `discover({ userDataDir?, channel? })` reads `<userDataDir>/DevToolsActivePort`, which Chrome writes when remote debugging is on: line 1 is the port (1 to 65535), line 2 the browser path (`/devtools/browser/<id>`). It answers `{ ok: true, wsEndpoint: "ws://127.0.0.1:<port><path>", userDataDir, source: "active-port-file", port, path }`, or `{ ok: false, code, remedy, userDataDir }` with `missing-file`, `malformed-file`, or `stale-file` (the port does not accept a TCP connection on 127.0.0.1 within 500 ms, as after Chrome crashed). Every remedy says to enable remote debugging at `chrome://inspect/#remote-debugging` and keep Chrome open. `DiscoveryResultSchema` in `packages/protocol` is the shape, so the service and `doctor` reuse it.
- **Default user-data dirs.** Without `userDataDir`, the channel (`stable`, `beta`, `dev`, `canary`) picks the folder Chromium uses: macOS `~/Library/Application Support/Google/Chrome` (`Chrome Beta`, `Chrome Dev`, `Chrome Canary`); Windows `%LOCALAPPDATA%\Google\Chrome\User Data` (`Chrome Beta`, `Chrome Dev`, `Chrome SxS`); Linux `$CHROME_CONFIG_HOME`, else `$XDG_CONFIG_HOME`, else `~/.config`, then `google-chrome` (`google-chrome-beta`, `google-chrome-unstable`, `google-chrome-canary`). The platform, environment, file reader, and port probe are options, so unit tests run on temporary directories.
- **Connection** (`src/connection.ts`, F1.2). `connect(endpoint, { source, onEvent })` first sends `Target.getTargets` on a raw browser-level WebSocket of its own (`src/raw-cdp.ts`, Node's global `WebSocket`, no import), then opens Playwright `connectOverCDP` and a browser CDP session (`src/playwright-transport.ts`). The handshake (`src/handshake.ts`) reads `Browser.getVersion` and probes each domain of `CDP_PROBE_DOMAINS` with a side-effect-free command: `Target` on the browser session, the others on a CDP session of ours on the first page, detached afterwards. A domain is `unavailable` only when Chrome answers that the method `wasn't found`; any other answer means the domain exists and is recorded as the `reason`.
- **Loss and reconnection.** When the socket drops without `disconnect()`, the adapter emits one `connection.lost` event whose `gap` is a journal gap payload (`reason: "connection-lost"`, `startedAt`, the last `seq` seen); writing it to a run's `coverage.json` comes with runs (F3.5). `reconnect()` runs discovery again on the same `source` (`userDataDir` or `activePortFile`) and connects only when that `DevToolsActivePort` answers again; otherwise it returns `endpoint-gone` with discovery's remedy. Adapter events carry one producer `seq` across reconnections.
- **Contested control.** CDP marks a target `attached` while any client holds a session, and fires `targetInfoChanged` only for the first one. Before Playwright attaches, the preflight `Target.getTargets` therefore shows exactly the pages another debugger holds; each yields `control.contested` (`signal: "attached-before-connect"`) at connect and at each reconnect, and RECnRun never detaches the other client. A debugger that attaches after RECnRun (DevTools opened later) changes neither the flag nor any event, so it goes unreported: the capability is `partial` (M-F1.d).
- **Instrumentation** (`src/instrumentation.ts`, F1.4). `instrument(endpoint, { onEvent })` opens a browser-level CDP socket of its own (`src/cdp-socket.ts`, flatten mode, so child sessions are reached by `sessionId`) and sends `Target.setAutoAttach` with `autoAttach`, `flatten`, and `waitForDebuggerOnStart`, which attaches every existing target and holds every new one before its first script. For each attached `page` or `iframe` it sends, in order, nested `Target.setAutoAttach`, `Page.enable`, `Page.addScriptToEvaluateOnNewDocument` with the hook (`src/hook-source.ts`), `Runtime.enable`, `Runtime.addBinding` (`__recnrunObserver`), and then `Runtime.runIfWaitingForDebugger` only when Chrome held the target (`before-first-script`); a dedicated worker gets nested auto-attach, `Runtime.enable`, and the binding, a service worker `Runtime.enable` and the binding, and every other target type is only resumed (`ignored`). The commands go out in one burst without awaiting replies: a session runs them in order, and a held worker answers nothing until it is resumed. A target already running at connect is `late`, and no resume is sent. `runImmediately` hooks any document that already has a script context: a late target's current document, or a popup's `about:blank`, whose context exists as soon as `window.open` returns and may predate the hook when another client (Playwright, DevTools) resumed the popup first, since Chrome releases a held popup on the first client's resume.
- **The hook.** It runs in the page's main world before the application's first script, defines a frozen `window.__recnrunHook` (`version`, `installedAt`, `documentId`, 32 random hex digits per document), and posts `document.hook-installed` with its URL through the binding, numbered by a per-document `seq`. When the binding is not there yet (a late target), an accessor queues messages until `Runtime.addBinding` assigns it, since V8 installs a binding with an ordinary set. Chrome gives a popup opened with `window.open` the script context of its initial `about:blank` document again for its first same-origin document, without running new-document scripts: the hook is therefore already in place there, and it starts the new document's `documentId` and posts its install the first time `__recnrunHook` is read in it.
- **Validation and drops.** A binding payload longer than 64 KiB, not JSON, or not an `ObserverMessageSchema` message increments `droppedInvalid`; one from an execution context CDP never announced on that session, or claiming another target id, increments `droppedUnknownFrame`. An accepted message becomes an `InstrumentationEvent` with `targetId`, `sessionId`, `frameId` (from the context's `auxData`, `null` in a worker), `documentId`, the install mode, and a `seq` per source (one attached session). `report()` lists every attached session with its install mode, `hookInstalled`, `hookInstalls`, both drop counters, `detached`, and the first failed install command, and says whether dedicated and service workers were observed as targets. Chrome can attach one target more than once (a service worker through the browser and through its page), so the report is per session. Nothing is captured inside workers yet (F6.2), and writing these events to the journal comes with F1.5.
- **Valibot.** The adapter validates every CDP reply it reads (`Target.getTargets`, `Browser.getVersion`, raw socket messages), every CDP event the instrumentation handles, and every binding message with the protocol schemas, which is why `adapter-boundaries` allows `valibot`.
- **Node built-ins.** Discovery is why `adapter-boundaries` allows `node:fs/promises` (read the file), `node:net` (probe the port), `node:os` (the home folder), and `node:path` (Windows and POSIX joins); no other built-in. The adapter only reads Chrome's file; persistence still owns RECnRun's own files.
- **Profile description** (`src/profile.ts`, F1.3). `describeProfile()` answers `{ userDataDir, browserContextIds, chrome }` for the current connection: the folder comes from the connection's `source` (a `userDataDir`, or the folder of an `activePortFile`), the contexts from `Target.getBrowserContexts` (its `browserContextIds` and `defaultBrowserContextId`) plus the `browserContextId` of every target, and `chrome` is the handshake's `Browser.getVersion` product. It is what a binding is created and refreshed from.

## Profile bindings

A flow names portable actors (`a`, `solicitante`); a profile binding ties a friendly name the user chose to one Chrome profile on this machine (PLAN.md F1.3, source plan §7). Bindings are local configuration: they live in `~/.recnrun/bindings.json` and never in a flow folder or an export.

- **Shape** (`packages/protocol/src/bindings.ts`). `ProfileBindingSchema` has `name`, `userDataDir`, `wsEndpoint` (last seen), `browserContextIds` (observed), `chrome` (the `Browser.getVersion` product), `createdAt`, and `lastSeenAt`. `BindingsFileSchema` is `{ schemaVersion: 1, bindings }` with unique names. The service command `profiles.list` returns these bindings.
- **Store** (`packages/persistence/src/bindings-store.ts`). `openBindingsStore({ home })` reads `<home>/.recnrun/bindings.json` (absent means no bindings) and validates it with `parseBindingsFile`, so persistence needs no Valibot. `save` adds a binding or replaces the one with its name; `remove` drops one. Every write goes to a temporary file in the same folder and is renamed over the target, with the file at mode 0600 and the folder at 0700. A file that is not JSON or not a bindings file is reported as a `BindingsFileError` naming its path, and no write replaces it.
- **Rules** (`packages/engine/src/bindings.ts`, pure). `detectDuplicateBinding` finds another name that already holds the candidate's `wsEndpoint` or `userDataDir`. `classifyBinding(binding, discovered, handshake?)` answers `fresh`, `stale-restarted` (the discovered `/devtools/browser/<id>` path or the Chrome version differs from what the binding recorded, with the new endpoint), or `stale-missing` (discovery failed, with its remedy). A stale binding is reported for the user to reconfirm; nothing remaps it to whatever Chrome answers now. `resolveActorBindings(flow, bindingByActor)` maps every actor the flow declares or uses, nested steps included, to a binding name, or fails with the first actor that has none.
- **Isolation.** The profile is the isolation boundary: two Chrome instances on two user-data dirs share no cookies or storage (`tests/browser/profiles.spec.ts`). The same test shows that a restarted Chrome gives the default browser context a new id, so `browserContextIds` are recorded as observed and never used to recognize a profile; the user-data dir and the reconfirmed name do that. Two profiles inside one Chrome instance are not automated (M-F1.c in [MANUAL_VALIDATION.md](plan/MANUAL_VALIDATION.md)).

## Website

```text
src/main.tsx ─► src/app ─► src/features/<name> ─► src/ui
                   │                                 ▲
                   └─────────────────────────────────┘
```

- `src/ui`: presentational components; props in, markup out. It imports nothing from `features` or `app`.
- `src/features/<name>`: one part of the page with its own content (`install-guide`). Features never import each other.
- `src/app`: composition of the page; `mount.tsx` renders it into the page's root element.
- `src/main.tsx`: imports the stylesheets and calls `mount`. Nothing imports it.
- The website imports no workspace package other than `@recnrun/brand` (`website-only-brand`): it ships no engine, protocol, or UI code.

## Fixture application

`apps/fixture` (`@recnrun/fixture`) is the web application the browser tests drive. It stands in for any application under test, so it shares no workspace code (`fixture-isolated`). `src/` is a Node HTTP server on built-ins only: `createFixtureServer({ port, secondPort })` returns `start()`, `stop()`, and `urls`, and `src/bin.ts` runs it. `public/` holds the pages and their plain ES module scripts.

- **Two origins.** It listens on `127.0.0.1` only, on port 4600 (`http://127.0.0.1:4600`) and port 4601, which pages address as `http://localhost:4601`. The other host name makes the second origin cross-site, so Chrome renders the `iframe` route's second child out of process. `RECNRUN_FIXTURE_PORT` and `RECNRUN_FIXTURE_SECOND_PORT` change the ports. `vp run dev:fixture` starts it by hand; `playwright.browser.config.ts` starts it for `vp run test:browser`.
- **Routes.** `/` lists every page as a link with `data-testid="route-<name>"`. Each page is `/routes/<name>`: `form`, `debounce`, `spa`, `submit-redirect` (lands on `submit-result`), `iframe` (embeds `iframe-child`), `popup` (opens `popup-child`), `virtual-list`, `ime`, `indexeddb`, `service-worker` (registers `/sw.js`), `worker` (starts the dedicated module worker `/worker.js` and pings it), `network`, `console`, `download`, `dialogs`, and `storage`. `src/routes.ts` is the list.
- **API.** `/api/json`, `/api/binary` (a PNG), `/api/error` (500), `/api/redirect/<n>` (a 302 chain down to `/api/json`), `/api/stream` (10 chunks over 3 s), `/api/download` (an attachment), `/api/submit` (form POST answered 303), `/api/cacheable` (what the service worker caches), `/api/config` (both origins), and the WebSocket echo `/ws/echo`.
- **Page contract.** Every control has a stable `data-testid` and an accessible name; `public/fixture.js` checks both, runs the page's own self-test, and only then sets `window.__fixture = { route, ready: true, counters, fail, loadId }`. `counters` counts handler runs (a button's clicks, the debounced handler, IndexedDB commits), so a test can prove an action ran exactly once; `loadId` changes only on a real reload. Each page's first script, right after `<meta charset>`, is a classic inline head check that records whether RECnRun's hook was already installed; `window.__fixture.hookSeenAtHead` reports it.
- **`?fail=<case>`.** Injects a defect on demand: `status` changes the form's status text, `api-500` makes `/api/json` answer 500, `slow` spaces the stream's chunks 1.5 s apart, and `throw` raises an uncaught error after the self-test.
- **Safety.** Files are served from `public/` only: a path that decodes to a `..` segment, a backslash, or a NUL byte gets 400. Every answer sends `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. There is no Content Security Policy, because the fixture is a test target.

## Security model

RECnRun reads the user's real Chrome profile, including request bodies and storage, so these are product requirements ([PLAN.md §6](plan/PLAN.md#6-security-tests-cross-cutting-source-17-and-19) lists the test for each, in the phase that introduces the surface):

- **No egress** (decision 8 of [ADR 0001](adr/0001-local-service-over-cdp.md#decision)). The service, the CLI, and the MCP server connect only to loopback. Tests run with `RECNRUN_FORBID_EGRESS=1`, which makes any other connection throw. Evidence is never sent to an AI, telemetry, or any external service.
- **The local API.** The service binds to loopback only. Every HTTP request and WebSocket carries the per-user bearer token from `~/.recnrun/service.json` (mode 0600), and the service checks `Origin` and `Host`, so a page the user visits cannot drive it.
- **Chrome connections.** The service connects only to a Chrome the user enabled remote debugging on, found through its `DevToolsActivePort`. Messages from page instrumentation are untrusted: they are validated with the protocol schemas and dropped when they come from an unknown target, frame, or document. Capture events never act as engine commands.
- **Capture scope.** A session names the tabs, profiles, and origins it captures; tabs outside it produce no events.
- **Captured content.** Viewers render captured HTML and bodies in a sandboxed frame where no script runs. Secrets are `${secrets.<name>}` references resolved from a local store and never written to a flow or an export; redaction runs before persistence.
- **Imports.** Importing a flow or a function never executes it; archives are checked for path traversal and decompression bombs.
- **Replay.** Write actions are never retried blindly; an unknown outcome is `indeterminate`.
- **The website.** recnrun.com holds no user data. It still ships a strict CSP (`default-src 'self'`, no inline scripts or styles; `apps/website/build/content-security-policy.ts`) as a `<meta>` tag, because GitHub Pages sends no headers. Third-party scripts are not allowed.

## Toolchain

| Concern                  | Tool                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Package manager, tasks   | Vite+ (`vp`) with pnpm workspaces and a version catalog                                                             |
| Format, lint, type check | `vp check`: Oxfmt, Oxlint (type aware, with `eslint-plugin-sonarjs`), tsgo                                          |
| Architecture boundaries  | dependency-cruiser (`.dependency-cruiser.cjs`)                                                                      |
| Dead code, duplication   | Knip (`knip.jsonc`), jscpd                                                                                          |
| Documentation            | `scripts/check-docs.mjs` (`vp run docs:check`): relative links and anchors resolve                                  |
| Unit and component tests | Vitest with V8 coverage; Vitest Browser Mode with Playwright Chromium                                               |
| End-to-end               | Playwright against the built website, in Docker                                                                     |
| Browser layer            | `vp run test:browser`: Google Chrome Stable for Linux, headed on Xvfb in Docker, found through `DevToolsActivePort` |

Findings from the bootstrap spike, kept here because they explain the configuration:

- **dependency-cruiser and TypeScript 7.** dependency-cruiser 18 supports TypeScript below 7, so it parses with SWC (`parser: "swc"`, `@swc/core`); type-only imports are still detected. Its tsconfig-paths plugin resolves `paths` from the working directory, so each app has a `tsconfig.deps.json` repeating its `@/` alias from the repo root, and `vp run deps` cruises each app with its own. npm packages are not followed but stay in the graph as leaves, so rules can name them (`not-to-dev-dep`); the `exclude` names only the workspaces' build output, since a pattern on `dist/` would also drop every package's own `dist/`.
- **Docker display.** Vitest Browser Mode runs headed; the test container provides Xvfb, so no window opens on the host. Google Chrome in the browser layer uses the same display.
- **Google Chrome in Docker.** `Dockerfile.tests` installs `google-chrome-stable` from Google's apt repository (amd64 and arm64) and writes `/opt/recnrun/versions.json`, which `scripts/test-container.mjs` copies with the image id into each run's `.artifacts/docker/<run-id>/versions.json`. Chrome runs as root in the container, where its sandbox cannot start, so the browser fixture adds `--no-sandbox` there and only there.
