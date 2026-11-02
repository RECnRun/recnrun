---
name: adding-a-service-command
description: Checklist for adding a command the RECnRun local service accepts from the UI, the CLI, or the MCP server (for example, starting a session, saving a flow, or querying run events). Use when a change needs a new service API command, a new result shape, or a new MCP tool.
---

# Adding a service command

The UI, the CLI, and the MCP server are clients of one local service; none of them carries its own engine. A command touches every layer, in this order. Work red/green at each step ([PLAN.md §3](../../../docs/plan/PLAN.md#3-how-acceptance-is-checked)).

1. **Protocol.** Add the command's request and result as Valibot schemas in `packages/protocol/src`, export them from `index.ts`, and add the command to the service API union. Regenerate the committed JSON Schema in `packages/protocol/schema/` so the drift test passes. Unit test parsing of a valid and an invalid value, including the error shape (code, step, capability, retryability, evidence, alternative).
2. **Engine or persistence.** Put the behavior in `packages/engine` (sessions, leases, steps) or `packages/persistence` (flows, runs, journal), never in the service. Engine code reaches Chrome only through the adapter interface; unit test it with the fake adapter.
3. **Service handler.** Handle the command in `apps/service`: validate the request with the protocol schema where it enters, check the bearer token, `Origin`, and `Host`, require the current lease and fencing token for any mutation, and validate the result before sending it. The command switch stays exhaustive (lint enforces it).
4. **Contract test.** Cover the real HTTP or WebSocket path in `tests/contract/*.test.ts`: a valid call, a malformed request, a missing token (401), a wrong `Origin` (403), and a stale lease for mutations. Run with `RECNRUN_FORBID_EGRESS=1`.
5. **MCP.** When agents need the command, expose it as an MCP tool in `apps/service` with a structured, paginated result, and extend `tests/contract/mcp.test.ts`. Logs go to stderr; stdout carries only JSON-RPC.
6. **UI and CLI.** Call the command from `apps/ui` through its service client and component test the view with a fake client; add a CLI subcommand in `apps/cli` only if the plan names one, with a test in `tests/contract/cli.test.ts`. Cover a user-visible path end to end in `tests/e2e`.
7. **Docs.** Describe the command in `docs/ARCHITECTURE.md` and, if it changes what a capability can do, update the matrix in `packages/protocol/src/capabilities.ts` and regenerate `docs/CAPABILITIES.md`. Bump the protocol version only for an incompatible change.
8. **Gate.** `vp run verify` exits 0.

A command that writes data, drives a page, or reads captured evidence widens the security model. Before adding one, document the threat and its test in the security model of `docs/ARCHITECTURE.md` and in the table of [PLAN.md §6](../../../docs/plan/PLAN.md#6-security-tests-cross-cutting-source-17-and-19).
