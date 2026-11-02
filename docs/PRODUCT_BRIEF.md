# Product brief

RECnRun is a local tool for testers, developers, and coding agents. It drives the Google Chrome already installed on the user's machine through the Chrome DevTools Protocol (CDP), turns what the user does into a declarative flow, and replays that flow with no AI involved. Flows and their evidence stay on the machine. The website at [recnrun.com](https://recnrun.com) only explains the tool and how to install it.

Why it is built this way: [ADR 0001](adr/0001-local-service-over-cdp.md) (local service over CDP) and [ADR 0002](adr/0002-retire-extension-and-bridge.md) (the M0 extension is retired). How it is delivered: [plan/PLAN.md](plan/PLAN.md).

## Concepts

| Concept          | Meaning                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flow**         | A persistent, declarative description of a scenario (YAML or JSON): its actors, inputs, requirements, preconditions, and steps. It is a file the user can read, edit, version, export, and import; not code.                                                            |
| **Step**         | One unit of a flow: an action (`click`, `fill`, `navigate`, …), an assertion (`textEquals`, `visible`, …), or a built-in (extraction, variables, control blocks). Each step has a stable id and its own timeout.                                                        |
| **Locator list** | How a step finds its element: an ordered list of strategies (role, text, test id, CSS, a registered function) with a resolution policy, a cardinality, and one shared deadline. Every attempt is traced.                                                                |
| **Actor**        | A portable role in a flow (`requester`, `approver`). The flow names actors, never machines or profiles.                                                                                                                                                                 |
| **Binding**      | The local link between an actor and a Chrome profile reachable over CDP, with a friendly name the user chose. Bindings live in `~/.recnrun`, never inside a flow, so a flow moves between machines unchanged.                                                           |
| **Run**          | One replay of a flow revision with a dataset. It records each step's status (`passed`, `failed`, `blocked`, `cancelled`, `indeterminate`, …), a summary, and an exit code.                                                                                              |
| **Evidence**     | What a run or a recording captured: actions, navigations, network requests and bodies, console, errors, storage operations, DOM snapshots, and screenshots, in a journal with blobs stored by hash.                                                                     |
| **Coverage**     | What a run could and could not observe, per surface, with every gap, truncation, and loss listed in `coverage.json`. Absence of evidence is never reported as evidence of absence. What each surface can capture today is listed in [CAPABILITIES.md](CAPABILITIES.md). |

## Product rules

- **No AI during replay.** Replay is deterministic engine code. Agents may help author or investigate a flow through the same service, but a run never calls a model or any host other than loopback (decision 8 in [ADR 0001](adr/0001-local-service-over-cdp.md#decision)).
- **Replay by meaning.** Actions target the element the locator list resolves, not old coordinates. A write action whose outcome is unknown is `indeterminate` and is never retried blindly.
- **Three separate operations.** Replaying a flow interacts with today's application and backend; inspecting a run reads its stored evidence without repeating any effect; replaying with mocks is a later feature.
- **Humans and agents share one engine.** The UI, the CLI, and the MCP server are clients of the same local service. Control of a tab is exclusive and can be handed over mid-session.
- **Explicit scope.** RECnRun captures only the tabs, profiles, and origins a session names; personal tabs outside that scope produce no events.
- **No silent healing.** A flow changes only through an edit that creates a new revision; past runs keep the revision they ran.

## Out of scope

Exact reproduction of JavaScript memory or backend state, a universal time-travel debugger, control of Chrome's own native UI, guarantees on closed shadow DOM, remote real-time collaboration, and identity virtualization inside one profile.

## Platforms

Google Chrome 144 or later on Windows and macOS, with Node.js 22.18 or later (24 LTS recommended). Automated gates run against Google Chrome Stable for Linux in Docker; the default profile on Windows and macOS is checked by hand ([MANUAL_VALIDATION.md](plan/MANUAL_VALIDATION.md)).
