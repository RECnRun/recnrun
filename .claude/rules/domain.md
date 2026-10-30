---
paths:
  - "packages/**"
---

# Domain and bridge packages

[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#packages) defines the contracts. Key rules:

- Packages export TypeScript sources directly (`exports` → `./src/index.ts`); there is no package build. `build` only type checks.
- **Brand.** `packages/brand` holds assets only (`src/mona-sans.css`, `src/fonts/`) and imports nothing; see [BRAND.md](../../docs/BRAND.md#typography).
- **Domain purity.** `packages/domain/src` imports only Valibot and itself: no Preact, WXT, browser APIs, or `@recnrun/bridge`. It holds data shapes and pure helpers.
- **Schemas first.** Each concept is a Valibot schema with its type inferred (`v.InferOutput`), never a hand-written interface that can drift. Ids are `IdSchema`; references between entities are ids too (`Step.workflowId`). Drafts (`WorkflowDraftSchema`, `StepDraftSchema`) hold what a caller provides; the full schema spreads the draft's entries and adds the identity fields.
- **Stored shapes.** The extension stores `Workflow` and `Step` as they are. A breaking change to one bumps the IndexedDB version in the extension's `workflow-store.ts` and migrates there; the domain stays version-free.
- **Bridge protocol.** `packages/bridge/src/protocol.ts` is the single source of message types. Every request type has a payload and a result schema in `REQUESTS`, and every pushed event a data schema in `EVENTS`; the host validates payloads, the client validates results and event data. Envelopes carry `channel: "recnrun"` and `protocol: 1`; an incompatible change bumps `protocol`, an added type, field, or event does not.
- **Transport.** Only `window-transport.ts` touches `window`. It accepts messages whose `source` is the target window and whose `origin` is the page's own origin, and posts only to that origin. Tests use the in-memory transport in `packages/bridge/tests/memory-transport.ts`.
- `@recnrun/domain/testing` exports fixtures (`sampleWorkflows`, `sampleWorkflow`, `sampleSteps`, `sampleStep`) for every test layer; production code never imports it.
- Adding a message: follow the `adding-a-bridge-message` skill.
