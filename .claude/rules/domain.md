---
paths:
  - "packages/**"
---

# Domain and bridge packages

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#packages) defines the contracts. Key rules:

- Packages export TypeScript sources directly (`exports` → `./src/index.ts`); there is no package build. `build` only type checks.
- **Domain purity.** `packages/domain/src` imports only Valibot and itself: no Preact, WXT, browser APIs, or `@recnrun/bridge`. It holds data shapes and pure helpers.
- **Schemas first.** Each concept is a Valibot schema with its type inferred (`v.InferOutput`), never a hand-written interface that can drift. Ids are `IdSchema`; references between entities, when they appear, are ids too (`recordingId`), and the snapshot rejects duplicate ids.
- **Versioning.** `SnapshotSchema` carries `schemaVersion`. A breaking change to stored data bumps it and adds a migration where the extension reads storage.
- **Bridge protocol.** `packages/bridge/src/protocol.ts` is the single source of message types. Every request type has a result schema in `RESULT_SCHEMAS`, and the client validates every result before returning it. Envelopes carry `channel: "recnrun"` and `protocol: 1`; an incompatible change bumps `protocol`.
- **Transport.** Only `window-transport.ts` touches `window`. It accepts messages whose `source` is the target window and whose `origin` is the page's own origin, and posts only to that origin. Tests use the in-memory transport in `packages/bridge/tests/memory-transport.ts`.
- `@recnrun/domain/testing` exports fixtures (`sampleSnapshot`) for every test layer; production code never imports it.
- Adding a message: follow the `adding-a-bridge-message` skill.
