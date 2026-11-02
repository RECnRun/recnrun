# Capabilities

<!-- Generated from packages/protocol/src/capability-matrix.ts. Do not edit. -->

This file is generated from the capability matrix in `packages/protocol`. Edit the matrix, then run `vp run capabilities:generate`; `vp run docs:check` fails when this file is stale. Status moves only with a test that shows the new behavior ([PLAN.md](plan/PLAN.md#7-working-rules-specific-to-this-plan)).

Statuses: `implemented` (proved by a test), `partial` (works with a stated limit), `unavailable` (cannot be done, and the limit is stated), `planned` (not built yet).

## Capture surfaces

| Id                           | Title                                         | Status  | Phase | Notes                                                                                                                        |
| ---------------------------- | --------------------------------------------- | ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| cache-storage-inventory-deep | Cache Storage inventory and diffs             | planned | F6.3  | Never confused with the HTTP cache, and never modified for convenience.                                                      |
| console-normal               | Console messages and errors                   | planned | F1.5  | Remote objects are serialized with limits at the instant of capture.                                                         |
| console-stacks-deep          | Console and error stack traces                | planned | F3.2  | Stack traces are recorded when Chrome provides them.                                                                         |
| cookies-changes-normal       | Cookie changes                                | planned | F3.4  | Taken from CDP and network data; internal access has no universal audit.                                                     |
| cookies-httponly-deep        | HttpOnly cookies                              | planned | F6.3  | Visible through the CDP cookie API only, never through document.cookie.                                                      |
| dom-events-normal            | DOM events                                    | planned | F1.5  | Pointer, keyboard, input, composition, focus, scroll, submit, and dialog events as raw events.                               |
| dom-snapshots-deep           | More frequent DOM snapshots                   | planned | F6.5  | Extra snapshots are enabled per scenario and measured against the Normal level.                                              |
| dom-snapshots-normal         | DOM snapshots at milestones                   | planned | F3.3  | Taken at milestones, around actions, and on failure; not a heap snapshot.                                                    |
| files-opfs-metadata-deep     | Files and OPFS metadata                       | planned | F6.4  | Handles, permissions, streams, and sync handles have limits, and the rest of the OS is not observed.                         |
| frames-targets-normal        | Frames and cross-origin targets               | planned | F1.4  | Targets that cannot be attached produce declared gaps.                                                                       |
| indexeddb-operations-deep    | IndexedDB requests, cursors, and transactions | planned | F6.1  | A successful request does not prove a commit, so the transaction outcome is recorded; aborts and upgrades matter.            |
| indexeddb-snapshots-deep     | IndexedDB selective snapshots                 | planned | F6.1  | Binary, Blob, Date, composite keys, and structured clone need typed codecs.                                                  |
| navigation-normal            | Navigation and target lifecycle               | planned | F1.5  | Events before the connection are not recovered, and a reload may be needed to cover initialization.                          |
| network-bodies-normal        | Network bodies                                | planned | F3.1  | Stored as blobs with a condition (captured, truncated, unavailable, not-requested); streams and downloads can be incomplete. |
| network-evidence-normal      | Network headers, timing, and cache state      | planned | F3.1  | Sizes are capped and sensitive values are redacted before persistence.                                                       |
| network-requests-normal      | Network requests and responses                | planned | F1.5  | Request, response, failure, and redirect events; bytes that were not collected are never reconstructed.                      |
| screenshots-normal           | Screenshots                                   | planned | F3.3  | Still images at milestones, not a full video.                                                                                |
| service-workers-deep         | Service workers                               | planned | F6.2  | Already-initialized service workers are reported as gaps, and none is modified for convenience.                              |
| sse-events-normal            | Server-sent events                            | planned | F3.1  | Captured only when Chrome reports them; long-lived streams are bounded by volume limits.                                     |
| web-storage-changes-normal   | localStorage and sessionStorage changes       | planned | F3.4  | Observed through CDP storage events; reads and property access can escape.                                                   |
| web-storage-operations-deep  | localStorage and sessionStorage operations    | planned | F6.5  | Hooks on accessible operations, labeled observed-operation, never as a full audit.                                           |
| websocket-frames-normal      | WebSocket frames                              | planned | F3.1  | Truncation and encoding are flagged, and a capture is evidence rather than a deterministic replay.                           |
| workers-deep                 | Dedicated workers                             | planned | F6.2  | Workers already running at connection time are reported as gaps.                                                             |

## Features

| Id                       | Title                                          | Status      | Phase | Notes                                                                                                  |
| ------------------------ | ---------------------------------------------- | ----------- | ----- | ------------------------------------------------------------------------------------------------------ |
| agent-skills             | Agent skills                                   | planned     | F5.3  | A criterion is covered with evidence or not covered, never satisfied by absence of error.              |
| agents-setup             | Agent setup for Claude Code and Codex          | planned     | F5.2  | Never overwrites existing configuration and supports undo.                                             |
| builtin-migration        | Built-in promotion with migration              | planned     | F5.7  | Opt-in; no flow changes silently.                                                                      |
| capability-matrix        | Capability matrix as code                      | implemented | F0.4  | Delivered by F0.4; packages/protocol/tests/capability-matrix.test.ts guards the generated document.    |
| cdp-connection           | CDP connection and handshake                   | planned     | F1.2  | Cannot attach to a Chrome that has not enabled remote debugging.                                       |
| chrome-discovery         | Chrome discovery                               | planned     | F1.1  | Reads DevToolsActivePort; the default-profile remote-debugging dialog stays manual (M-F1).             |
| chrome-in-docker         | Google Chrome Stable in the Docker test image  | implemented | F0.6  | Delivered by F0.6; tests/container/runner.checks.mjs asserts Google Chrome 144 or newer on Linux only. |
| cli-local                | CLI: open, run, doctor                         | planned     | F2.7  | Exit codes 0, 1, and 2 for passed, failed, and error.                                                  |
| coverage-loss-accounting | Coverage and loss accounting                   | planned     | F3.5  | Bounded buffers emit explicit gap events instead of dropping silently.                                 |
| crash-recovery           | Crash recovery                                 | planned     | F3.6  | In-flight write steps become indeterminate and nothing is re-executed.                                 |
| custom-locator-path      | Custom locator function path                   | planned     | F1.7  | Synchronous infinite loops are cut with Runtime.terminateExecution and the outcome is recorded.        |
| deep-level               | Deep capture level                             | planned     | F6.5  | Toggled per scenario and measured against Normal.                                                      |
| diagnostics-ui           | Diagnostics timeline                           | planned     | F3.7  | Causal confidence is labeled; correlation is not proof.                                                |
| docs-link-check          | Documentation link and generated-file check    | implemented | F0.1  | Delivered by F0.1 and F0.4; scripts/check-docs.checks.mjs covers it.                                   |
| events-before-connection | Events from before the connection              | unavailable | F1.2  | Events that happened before CDP attached are not recoverable and are reported as a gap.                |
| fixture-app              | Fixture application                            | planned     | F0.5  | Two-origin app for browser tests; marked implemented when F0.5 lands.                                  |
| flow-persistence         | Flow folders and immutable revisions           | planned     | F2.4  | The SQLite index can always be rebuilt from the folders.                                               |
| flow-status-requirements | Flow status and requirement coverage           | planned     | F4.5  | A recording is not validated until a replay passes.                                                    |
| full-editor              | Full flow editor                               | planned     | F4.1  | Every change creates a revision and past runs keep theirs.                                             |
| function-export-import   | Function export and import                     | planned     | F4A.7 | Import never downloads anything.                                                                       |
| function-promotion       | Promotion to built-in                          | planned     | F4A.8 | Exercised once on a generic locator.                                                                   |
| function-registry        | Custom function registry                       | planned     | F4A.2 | Versions are immutable and pinned; no latest during replay.                                            |
| function-runtimes        | Function runtimes                              | planned     | F4A.3 | worker_threads isolates state and cancellation but is not a security sandbox.                          |
| handoff                  | Agent handoff                                  | planned     | F5.4  | The in-flight command becomes indeterminate.                                                           |
| import-export            | Flow export and import                         | planned     | F4.4  | Secrets are references and are never serialized.                                                       |
| inputs-datasets          | Inputs, datasets, and variables                | planned     | F4.2  | Datasets never hold secrets.                                                                           |
| instrumentation-order    | Instrumentation before application scripts     | planned     | F1.4  | Ordering is proved on Chrome in Docker before any claim.                                               |
| lifecycle                | Setup, uninstall, and update                   | planned     | F7.2  | Setup is idempotent and never restarts Chrome.                                                         |
| locator-function-ui      | UI for locators, functions, and blocks         | planned     | F4A.6 | Includes extracting a macro from selected steps.                                                       |
| locator-lists            | Locator lists and cardinality                  | planned     | F4A.1 | A second strategy never runs after a dispatched action fails.                                          |
| macro-sdk                | Macro SDK                                      | planned     | F4A.5 | Produces child steps and events with redaction.                                                        |
| macros                   | Macros, loops, and conditionals                | planned     | F4A.4 | Loops need mandatory limits; interruption after an effect is indeterminate.                            |
| mcp-server               | MCP server                                     | planned     | F5.1  | A thin stdio adapter to the service; stdout is reserved for the protocol.                              |
| multiple-profiles-actors | Multiple profiles and actors                   | planned     | F4.3  | Actors are portable roles; bindings are local.                                                         |
| normalization            | Event normalization into steps                 | planned     | F2.3  | Suggested steps keep references to their raw events.                                                   |
| npm-package              | npm package                                    | planned     | F7.1  | Installs from the tarball on a clean Node container with Chrome.                                       |
| overhead-benchmark       | Capture overhead benchmark                     | planned     | F3.9  | Compares no instrumentation, Normal, and Deep.                                                         |
| profile-bindings         | Profiles as bindings                           | planned     | F1.3  | Bindings stay outside flow packages in ~/.recnrun/bindings.json.                                       |
| protocol-schemas         | Protocol schemas v1 and JSON Schema export     | implemented | F0.3  | Delivered by F0.3 and guarded by packages/protocol/tests/schema-drift.test.ts.                         |
| release-gate             | Release gate                                   | planned     | F7.4  | Manual items M-F1 to M-F7 are recorded before any publish.                                             |
| replay-executor          | Replay executor                                | planned     | F2.5  | Write actions are never retried blindly.                                                               |
| replay-spike             | Replay spike                                   | planned     | F1.6  | Actions use real input events, never direct value assignment.                                          |
| reproducers              | Reproducers                                    | planned     | F5.5  | Written under regressions/ and runnable as a test.                                                     |
| run-compare-query        | run.compare and run.queryEvents                | planned     | F3.8  | Paginated and filterable.                                                                              |
| scoped-reset             | Initial state and scoped reset                 | planned     | F4.6  | Only an authorized origin is reset, as an explicit operation.                                          |
| service                  | Local service                                  | planned     | F2.1  | Loopback only, bearer token, one instance per user.                                                    |
| sessions-control-leases  | Sessions, control, and leases                  | planned     | F2.2  | Exclusive control per target with fencing tokens.                                                      |
| ui-minimal               | Minimal UI                                     | planned     | F2.6  | Setup, catalog, recorder, editor, and run screens.                                                     |
| video-and-heap-snapshots | Full video and heap snapshots                  | unavailable | F3.3  | Out of scope: evidence is DOM snapshots and screenshots at milestones.                                 |
| workspace-skeleton       | Workspace skeleton and architecture boundaries | implemented | F0.2  | Delivered by F0.2 and enforced by vp run deps.                                                         |
