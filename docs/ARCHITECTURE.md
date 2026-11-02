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

| Workspace              | Holds                                                                                                                                      | May import                                                      | Since |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----- |
| `packages/protocol`    | Versioned schemas: flow DSL, locator lists, event envelope, run manifest, summary and coverage, capability matrix, service API, MCP shapes | `valibot`                                                       | F0.2  |
| `packages/engine`      | Sessions, leases, steps, locator resolution, recorder normalization, function registry, macro runtime                                      | `protocol`                                                      | F0.2  |
| `packages/adapter`     | Chrome discovery, the CDP connection, targets and frames, actions, instrumentation hooks, element references                               | `engine` (the adapter interface), `protocol`, `playwright-core` | F0.2  |
| `packages/persistence` | Flow folders, revisions, the JSONL journal, blobs by hash, the SQLite index, export and import                                             | `protocol`, `node:` builtins                                    | F0.2  |
| `packages/brand`       | The Mona Sans font and the stylesheet every app imports                                                                                    | nothing                                                         | M0    |
| `apps/service`         | The loopback HTTP and WebSocket API, locks, lifecycle, logs, the MCP stdio adapter; serves the built UI                                    | `engine`, `adapter`, `persistence`, `protocol`                  | F0.2  |
| `apps/ui`              | The Preact SPA on localhost: catalog, recorder, editor, run, diagnostics                                                                   | `protocol`, `brand`, `preact`                                   | F0.2  |
| `apps/cli`             | `setup`, `open`, `run`, `doctor`, `agents setup`, `mcp`; published as `@recnrun/cli`                                                       | `service`                                                       | F0.2  |
| `apps/fixture`         | The deliberately controllable test application                                                                                             | nothing from the workspace                                      | F0.2  |
| `apps/website`         | The public landing at recnrun.com and the install guide                                                                                    | `brand`                                                         | M0    |

- The engine never imports Playwright or CDP types. It defines the adapter interface (`BrowserAdapter`); `packages/adapter` imports that interface from `engine` and implements it, and `engine` never imports the adapter. The service wires the two together, so unit tests use a fake adapter and browser tests use the real one.
- Packages never import apps. Apps meet through `packages/protocol` and the service API; the only app that imports another is `apps/cli`, which starts `apps/service`.
- Packages export their TypeScript sources (`exports` → `./src/index.ts`); apps bundle them. A package `build` only type checks, and so do the Node apps (`service`, `cli`, `fixture`) until F7 bundles the CLI; `apps/ui` builds with Vite.
- `@recnrun/brand` holds no code: it exports `mona-sans.css`, which each app's entry imports, so the font and its license exist once. It imports nothing (`brand-is-leaf`).
- Every module is reachable from an entrypoint, a test, or a config (`no-orphans`), and there are no import cycles (`no-circular`).

Each workspace has one dependency-cruiser rule that lists what its `src` may import; anything else is a violation:

| Rule                         | From                   | Allowed targets                                                |
| ---------------------------- | ---------------------- | -------------------------------------------------------------- |
| `protocol-pure`              | `packages/protocol`    | itself, `valibot`                                              |
| `engine-not-to-adapter-impl` | `packages/engine`      | itself, `protocol` (no adapter, Playwright, CDP, or Node APIs) |
| `adapter-boundaries`         | `packages/adapter`     | itself, `engine`, `protocol`, `playwright-core`                |
| `persistence-boundaries`     | `packages/persistence` | itself, `protocol`, `node:` builtins                           |
| `service-boundaries`         | `apps/service`         | itself, `engine`, `adapter`, `persistence`, `protocol`         |
| `cli-only-service`           | `apps/cli`             | itself, `apps/service`                                         |
| `ui-only-protocol`           | `apps/ui`              | itself, `protocol`, `brand`, `preact`                          |
| `fixture-isolated`           | `apps/fixture`         | nothing from `apps/` or `packages/`                            |
| `website-only-brand`         | `apps/website`         | `brand` among the workspace packages                           |

A later task that needs a new import (for example `node:http` in the service) widens that workspace's rule and this table in the same change, with the reason. `src/main.tsx` and `src/bin.ts` of any app are entrypoints that nothing imports (`not-to-entrypoints`).

## Protocol

`packages/protocol/src` holds one module per concept; `index.ts` re-exports them.

| Module                                             | Shapes                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `flow.ts`, `steps.ts`, `actions.ts`, `locators.ts` | The flow DSL: actors, inputs, requirements, preconditions, action, assertion, and builtin steps, targets         |
| `interpolation.ts`                                 | `${env.*}`, `${inputs.*}`, `${vars.*}`, `${locals.*}`, and `${secrets.*}`; any other namespace is rejected       |
| `validate.ts`                                      | `validateFlow(input)`: the schema plus the cross-step checks, as `{ ok: true, flow }` or `{ ok: false, issues }` |
| `events.ts`                                        | The event envelope of the journal (source plan §11) and the gap record                                           |
| `run.ts`                                           | `manifest.json`, `steps.json`, `coverage.json`, and `summary.json` of a run, with the exit code of each status   |
| `states.ts`                                        | Session, control, and step states and their legal transitions (source plan §6)                                   |
| `capabilities.ts`                                  | Capture surfaces, statuses, and the capability matrix                                                            |
| `api.ts`, `api-commands.ts`                        | The request and response envelopes, error codes, and the params and result of every command (`SERVICE_COMMANDS`) |

The `if` block names its branches `steps` and `otherwise`, never `then`/`else`: an object with a `then` property is a thenable, so `await` or `return` in async code would treat a parsed step as a promise. The source plan's §9.3 example is adapted that way, with a comment in its fixture.

Each issue of `validateFlow` has a `code` (`unknown-action`, `unknown-namespace`, `duplicate-step-id`, `missing-input`, `cyclic-variable`, `nth-without-index`, and others in `FLOW_ISSUE_CODES`) and the `path` of the offending key from the flow's root.

`vp run schema:generate` writes JSON Schema for the flow, the event, the run files, the capability matrix, and the service envelopes to `packages/protocol/schema/*.json` through `@valibot/to-json-schema`, and the files are committed. `tests/schema-drift.test.ts` fails when a schema changes without regenerating them. JSON Schema describes structure only: rules written as `v.check` (known interpolation namespaces, `nth` needs an index, the exit code matches the status) and the cross-step checks of `validateFlow` are enforced by the protocol code, not by the exported files. Only `src` must stay pure; `scripts/` and `tests/` use Node APIs to write and read those files.

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
