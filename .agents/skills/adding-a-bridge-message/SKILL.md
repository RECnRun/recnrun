---
name: adding-a-bridge-message
description: Checklist for adding a request the RECnRun website sends to the extension (today `ping`, for detection, and `open-dashboard`). Use when a change needs a new bridge message type or a new result shape.
---

# Adding a bridge message

The website and the extension share no code paths except `@recnrun/domain` and `@recnrun/bridge`. A message touches every layer, in this order. Work red/green at each step.

The extension's dashboard reads and shows the user's data itself, in its own tab, which no web page can load. Add a request only for something the website itself needs; a request that returns recordings to the page reverses that decision, so record why in `docs/ARCHITECTURE.md` first.

1. **Domain.** If the result is a new shape, add its Valibot schema and inferred type in `packages/domain/src`, export it from `index.ts`, and extend `packages/domain/tests/fixtures.ts`. Unit test parsing of a valid and an invalid value.
2. **Protocol.** Add the type and its result schema to `RESULT_SCHEMAS` in `packages/bridge/src/protocol.ts`, and a builder in `messages` if it takes a payload. Extend `packages/bridge/tests/client.test.ts` (result validated, malformed result rejected) and `host.test.ts`.
3. **Background.** Add a `case` for the type to the route table in `apps/extension/src/background/routes.ts` (the `switch` must stay exhaustive; lint enforces it), reading or writing through a repository in `src/storage`. `BackgroundMessageSchema` picks the type up from the bridge's `RequestTypeSchema`. Unit test the route in `apps/extension/tests/background-listener.test.ts` with `fakeBrowser`.
4. **Content script.** Usually nothing: `src/content/forward.ts` relays every known request type. It never gains storage access.
5. **Website.** Expose the call from `apps/website/src/services/extension.ts` (the only bridge user), then use it from a feature in `src/features/<name>`. Unit test the state; component test the view with `apps/website/tests/fake-gateway.ts`.
6. **End to end.** Cover the real path in `tests/e2e` with `seedSnapshot` and the extension loaded. A write message also needs a forged-origin case like `origin-guard.spec.ts`.
7. **Docs.** List the message in the bridge section of `docs/ARCHITECTURE.md`. Bump `protocol` there and in `protocol.ts` only for an incompatible change.
8. **Gate.** `vp run verify` exits 0.

Writes from the website change the security model: any script on the production origin (recnrun.com) could send them. Before adding one, document the threat and the user confirmation it needs in `docs/ARCHITECTURE.md`.
