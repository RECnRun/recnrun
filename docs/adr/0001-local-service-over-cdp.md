# 0001: A local Node.js service drives the installed Chrome over CDP

## Status

Accepted on 2026-11-02 by the owner. Source: [PLAN.md §2](../plan/PLAN.md#2-decisions), decisions 1 to 8, and the assumptions confirmed in [PLAN.md §8](../plan/PLAN.md#8-assumptions-confirmed).

## Context

M0 shipped a Manifest V3 extension that owned the user's data and a website that read it through a `window.postMessage` bridge. The execution plan of 2026-11-01 ([source plan](../plan/source-2026-11-01.pt-BR.md)) asks for something an extension cannot give within its permission model:

- record and replay flows in the Google Chrome the tester already uses, including the default profile and other existing profiles (R2);
- capture actions, navigations, network traffic with bodies, console, errors, and storage, each within a declared coverage (R4);
- let humans and agents (Claude Code, Codex) share one engine and hand control over mid-session (R6);
- keep flows as declarative files separate from their evidence, and replay them with no AI involved (R1, R5);
- install on Windows and macOS with one or two commands plus Chrome's own confirmations (R8).

Chrome 144 lets a running Chrome accept a Chrome DevTools Protocol (CDP) connection after the user enables it at `chrome://inspect/#remote-debugging`. That path reaches every target and frame of the profile with no extension, at the cost of Chrome's permission dialog and its debugging banner, which the owner accepts (R3).

## Decision

1. **Architecture.** A Node.js and TypeScript service runs on the user's machine and connects to the installed Chrome over CDP. It serves the UI on localhost; a CLI started through `npx` opens and drives it; an MCP server and agent skills are optional clients of the same service. UI, CLI, and MCP never carry their own replay engine. The F1 spike validates the limits of this architecture; it does not reopen the choice.
2. **The extension and the bridge are retired.** The service owns the data. See [0002](0002-retire-extension-and-bridge.md).
3. **Runtime matrix.** Node.js 24 LTS is the official runtime in CI and Docker. `engines.node` stays `>=22.18.0`, because `node:sqlite` needs 22.13 or later. Google Chrome 144 or later is required for the authorized connection to a running Chrome.
4. **Connection discovery.** With remote debugging on, Chrome writes `<user-data-dir>/DevToolsActivePort` (the port, then the WebSocket path). The adapter reads that file and connects to `ws://127.0.0.1:<port><path>`, the algorithm `chrome-devtools-mcp` uses. It works whether the user enabled debugging at `chrome://inspect/#remote-debugging` (Chrome shows a dialog and a banner) or Chrome started with `--remote-debugging-port=0` on a non-default `--user-data-dir` (no dialog; used in Docker). Only the dialog and the toggle need a person.
5. **Automated browser target.** The Docker test image installs Google Chrome Stable for Linux, not Chromium or Chrome for Testing, and starts it headed on Xvfb with a throwaway `--user-data-dir`. Every browser-facing gate runs there. Results read "Google Chrome <version> on Linux"; they never stand in for the default profile on Windows or macOS, which [MANUAL_VALIDATION.md](../plan/MANUAL_VALIDATION.md) covers.
6. **Libraries.** Playwright 1.64.1 `connectOverCDP` for actions and assertions; raw CDP sessions for instrumentation; Valibot for schemas, with JSON Schema exported through `@valibot/to-json-schema` and committed; `node:sqlite` for the local index, so there is no native build; `ws` for the service WebSocket; Preact for the UI; `yaml` for flow files.
7. **Package name.** The CLI is published as `@recnrun/cli`. Publishing is manual and needs the owner's authorization (M-F7.c); the owner creates the npm scope before the release gate.
8. **No egress.** The service, the CLI, and the MCP server never connect to a host other than loopback. Tests run with `RECNRUN_FORBID_EGRESS=1`, which makes any other connection throw; that is how "no AI call during replay" is checked rather than promised.

## Consequences

- The repository is reshaped into the layout of [PLAN.md §4](../plan/PLAN.md#4-target-layout): `packages/protocol`, `engine`, `adapter`, `persistence`, and `apps/service`, `ui`, `cli`, `fixture` (F0.2). The engine never imports Playwright or CDP types; it defines the adapter interface, so unit tests use a fake adapter.
- Security moves from an extension's permission model to a local service's: loopback only, a per-user bearer token, `Origin` and `Host` validation, an explicit capture scope per tab, profile, and origin, and sandboxed viewers for captured HTML ([ARCHITECTURE.md](../ARCHITECTURE.md#security-model), [PLAN.md §6](../plan/PLAN.md#6-security-tests-cross-cutting-source-17-and-19)).
- The Docker test image gains Google Chrome Stable and a `test:browser` layer (F0.6). The default profile, Chrome's dialog, and installs on Windows and macOS stay manual checks scheduled before the release gate.
- A user sees Chrome's debugging banner whenever RECnRun is connected. The landing and the install guide say so.
- Capture is partial by nature: every run writes `coverage.json` with its gaps, and a missing event is never presented as an absent one.
