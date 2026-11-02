---
paths:
  - "packages/**"
---

# Packages

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#target-layout) defines the workspaces and what each may import; `.dependency-cruiser.cjs` enforces it. The packages are `brand`, `protocol`, `engine`, `adapter`, and `persistence`, each with its own rule there. Key rules:

- Packages export TypeScript sources directly (`exports` → `./src/index.ts`); there is no package build. `build` only type checks. Packages never import apps.
- **Brand.** `packages/brand` holds assets only (`src/mona-sans.css`, `src/fonts/`) and imports nothing; see [BRAND.md](../../docs/BRAND.md#typography).
- **Protocol purity.** `packages/protocol/src` imports only Valibot and itself: no Node APIs, browser APIs, Playwright, or other workspace code. It is the single source of every shape that crosses a boundary: flows, steps, locator lists, events, run files, capabilities, service commands, and MCP tools.
- **Schemas first.** Each concept is a Valibot schema with its type inferred (`v.InferOutput`), never a hand-written interface that can drift. JSON Schema exported to `packages/protocol/schema/*.json` is committed; regenerate it with `vp run schema:generate`, or the drift test (`tests/schema-drift.test.ts`) fails.
- **Versioning.** Flows and stored files carry `schemaVersion`. A breaking change bumps it and adds a migration where the data is read; nothing changes a user's flow silently.
- **Engine.** `packages/engine` imports only `protocol` (`engine-not-to-adapter-impl`). It defines the adapter interface it needs (`BrowserAdapter`) and never imports the adapter, Playwright, CDP types, `node:fs`, or `node:sqlite`, so unit tests run it with a fake adapter.
- **Adapter.** `packages/adapter` is the only package that imports `playwright-core` or speaks CDP. It imports the interface from `engine` and implements it, and validates every CDP reply and every message from page instrumentation with `valibot` and the protocol schemas before it becomes an event. Of the Node built-ins it may import only `node:fs/promises`, `node:net`, `node:os`, and `node:path`, for discovery: it reads Chrome's `DevToolsActivePort` and probes its loopback port, never RECnRun's own files.
- **Persistence.** `packages/persistence` is the only package that touches the file system and `node:sqlite`. Writes of metadata are atomic, the journal tolerates a truncated last line, and the SQLite index can always be rebuilt from the flow folders. It also owns the user's local files in `~/.recnrun`, such as the profile bindings in `bindings.json` (mode 0600), which never go into a flow folder; it validates them through protocol helpers (`parseBindingsFile`), since it does not import Valibot.
- **No egress.** No package opens a network connection to anything but loopback; tests run with `RECNRUN_FORBID_EGRESS=1`.
- Adding a service command: follow the `adding-a-service-command` skill.
