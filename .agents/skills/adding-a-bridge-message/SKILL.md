---
name: adding-a-bridge-message
description: Checklist for adding a request the RECnRun website sends to the extension (for example, listing or saving data). Use when a change needs a new bridge message type or a new result shape.
---

# Adding a bridge message

The website and the extension share no code paths except `@recnrun/domain` and `@recnrun/bridge`. A message touches every layer, in this order. Work red/green at each step.

1. **Domain.** If the payload or the result is a new shape, add its Valibot schema and inferred type in `packages/domain/src`, export it from `index.ts`, and extend `packages/domain/tests/fixtures.ts`. Unit test parsing of a valid and an invalid value.
2. **Protocol.** Add the type with its `payload` and `result` schemas to `REQUESTS` in `packages/bridge/src/protocol.ts` (`NoPayload` when it takes none). Extend `packages/bridge/tests/client.test.ts` (result validated, malformed result rejected) and `host.test.ts` (payload validated, malformed payload refused).
3. **Background.** Handle the type in `apps/extension/src/background/handler.ts`: either read the store directly or add a method to the controller in `src/background/workflows.ts` so the popup and the public API share it. The `switch` must stay exhaustive (lint enforces it). Unit test it in `handler.test.ts`.
4. **Public API.** Only if an agent needs it: add the type to `EXTERNAL_REQUEST_TYPES` in `src/messaging/background-protocol.ts`, extend the "exposes exactly the control types" test, and teach it in the `recording-a-workflow` skill. Reads and grants stay off the API.
5. **Content script and popup.** Usually nothing: `src/content/forward.ts` relays every known request type, and the popup calls `send(type, payload)`. The content script never gains storage access.
6. **Website.** Expose the call from `apps/website/src/services/extension.ts` (the only bridge user), then use it from a feature in `src/features/<name>`. Unit test the state; component test the view with `apps/website/tests/fake-gateway.ts`.
7. **End to end.** Cover the real path in `tests/e2e/workflows.spec.ts` with data produced through the public API or the popup (`tests/e2e/fixtures/public-api.ts`). A write message also needs a forged-origin case like `origin-guard.spec.ts`.
8. **Docs.** List the message in the bridge tables of `docs/ARCHITECTURE.md`, with its public API column. Bump `protocol` there and in `protocol.ts` only for an incompatible change.
9. **Gate.** `vp run verify` exits 0.

A pushed **event** (extension → website) follows the same path with `EVENTS` in `protocol.ts`, a variant in `TimelineMessageSchema` (`src/messaging/background-protocol.ts`), a `deliver` case in `src/content/timeline.ts`, a `notify` call in the background, and an `on<Name>` subscription in the gateway.

Writes from the website change the security model: any script on the production origin (recnrun.com) could send them, and public API types can be sent by any page on an allowed origin. Before adding one, document the threat and the user confirmation it needs in `docs/ARCHITECTURE.md`.
