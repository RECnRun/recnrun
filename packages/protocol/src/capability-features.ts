import type { Capability } from "./capabilities.ts";

import { implemented } from "./capability-planned.ts";

type Feature = Extract<Capability, { kind: "feature" }>;

// Only what a task delivered is implemented; everything else moves with its own test (PLAN.md §7).
export const FEATURE_CAPABILITIES: Feature[] = [
  {
    kind: "feature",
    id: "protocol-schemas",
    title: "Protocol schemas v1 and JSON Schema export",
    status: "implemented",
    phase: "F0.3",
    notes: "Delivered by F0.3 and guarded by packages/protocol/tests/schema-drift.test.ts.",
  },
  {
    kind: "feature",
    id: "capability-matrix",
    title: "Capability matrix as code",
    status: "implemented",
    phase: "F0.4",
    notes:
      "Delivered by F0.4; packages/protocol/tests/capability-matrix.test.ts guards the generated document.",
  },
  {
    kind: "feature",
    id: "docs-link-check",
    title: "Documentation link and generated-file check",
    status: "implemented",
    phase: "F0.1",
    notes: "Delivered by F0.1 and F0.4; scripts/check-docs.checks.mjs covers it.",
  },
  {
    kind: "feature",
    id: "workspace-skeleton",
    title: "Workspace skeleton and architecture boundaries",
    status: "implemented",
    phase: "F0.2",
    notes: "Delivered by F0.2 and enforced by vp run deps.",
  },
  {
    kind: "feature",
    id: "chrome-in-docker",
    title: "Google Chrome Stable in the Docker test image",
    status: "implemented",
    phase: "F0.6",
    notes:
      "Delivered by F0.6; tests/container/runner.checks.mjs asserts Google Chrome 144 or newer on Linux only.",
  },
  {
    kind: "feature",
    id: "fixture-app",
    title: "Fixture application",
    status: "implemented",
    phase: "F0.5",
    notes:
      "Delivered by F0.5; tests/browser/fixture.spec.ts opens every route on two origins in Google Chrome.",
  },
  {
    kind: "feature",
    id: "chrome-discovery",
    title: "Chrome discovery",
    status: "implemented",
    phase: "F1.1",
    notes:
      "Delivered by F1.1; tests/browser/discover.spec.ts on Linux in Docker. The default-profile dialog on macOS and Windows stays manual (M-F1.a, M-F1.b).",
  },
  {
    kind: "feature",
    id: "cdp-connection",
    title: "CDP connection and handshake",
    status: "implemented",
    phase: "F1.2",
    notes:
      "Delivered by F1.2; tests/browser/connect.spec.ts on Linux in Docker. Reads Browser.getVersion and probes eight domains. Cannot attach to a Chrome that has not enabled remote debugging.",
  },
  {
    kind: "feature",
    id: "connection-loss-reconnect",
    title: "Connection loss and reconnection",
    status: "implemented",
    phase: "F1.2",
    notes:
      "Delivered by F1.2; tests/browser/connect.spec.ts kills Chrome: connection.lost carries a gap, and reconnect succeeds only once the same DevToolsActivePort answers again.",
  },
  {
    kind: "feature",
    id: "contested-control",
    title: "Another debugger on a target",
    status: "partial",
    phase: "F1.2",
    notes:
      "F1.2; tests/browser/connect.spec.ts. control.contested is reported for a page another client attached before RECnRun connected or reconnected, and that client is never detached. CDP exposes only a per-target attached flag and no event once RECnRun is attached, so DevTools opened later goes unnoticed (M-F1.d).",
  },
  implemented(
    "profile-bindings",
    "F1.3",
    "Profiles as bindings",
    "Delivered by F1.3 for two Chrome instances; tests/browser/profiles.spec.ts on Linux in Docker proves two Chrome instances share no storage, and that a flow's actor maps to its binding in that test's own dispatch. Engine-level actor dispatch is F4.3: until then the replay executor rejects multi-actor flows as multi-actor-unsupported. A restart is reported stale, never remapped. Bindings live in ~/.recnrun/bindings.json, never in a flow. Two profiles in one Chrome stay manual (M-F1.c).",
  ),
  {
    kind: "feature",
    id: "instrumentation-order",
    title: "Instrumentation before application scripts",
    status: "implemented",
    phase: "F1.4",
    notes:
      "Delivered by F1.4; tests/browser/instrumentation.spec.ts on Linux in Docker: the fixture's head script finds the hook on load, reload, SPA navigation, same-origin and cross-site iframes, and popups, and forged binding messages are dropped and counted.",
  },
  implemented(
    "replay-spike",
    "F1.6",
    "Replay spike",
    "Delivered by F1.6; tests/browser/replay-spike.spec.ts on Linux in Docker: the adapted source §9 example runs navigate, fill, click, extractText, and textEquals through the CDP adapter with trusted input events only; ?fail=status fails exactly the assertion, with the observed text. The full executor is F2.5.",
  ),
  implemented(
    "custom-locator-path",
    "F1.7",
    "Custom locator function path",
    "Delivered by F1.7; tests/browser/function-locator.spec.ts on Linux in Docker. The function runs in an isolated world, its elements become references qualified by target, frame, and loader id, and cardinality picks from them. A synchronous infinite loop is cut with Runtime.terminateExecution on the same session, and the tab answered Runtime.evaluate afterwards without being closed; the result records blocked, terminated, and tabResponsive.",
  ),
  implemented(
    "service",
    "F2.1",
    "Local service",
    "Delivered by F2.1; tests/contract/service-auth.test.ts and tests/contract/service-lifecycle.test.ts. Binds 127.0.0.1 only; every HTTP request and WebSocket needs the bearer token from ~/.recnrun/service.json (0600), a foreign Origin or Host gets 403, a WebSocket without the token closes 4401. One instance per user with stale-lock recovery; SIGTERM drains open journals before exit. Implements capabilities.get and health.",
  ),
  implemented(
    "sessions-control-leases",
    "F2.2",
    "Sessions, control, and leases",
    "Delivered by F2.2 in the engine: session, control, step, and pause transition tables, every state and event checked (packages/engine/tests/session.test.ts); a lease per target with heartbeat, expiry, and a fencing token that turns a delayed command from a previous lease into stale-lease (packages/engine/tests/lease.test.ts); the three pauses resume independently (packages/engine/tests/pause.test.ts).",
  ),
  implemented(
    "normalization",
    "F2.3",
    "Event normalization into steps",
    "Delivered by F2.3; packages/engine/tests/normalization.test.ts runs one golden pair per rule over schema-valid captured events: fill grouping, redacted fill, type for special keys and transformed values, no navigate after a link or submit click, scroll policy, dblclick, drag, shortcuts, composition, overlay exclusion, replay-caused exclusion, and actor by producer or binding with untrusted events excluded. Suggested steps keep references to their raw events. dblclick and drag have no flow action yet, and role locators need an accessible name the hook does not capture yet.",
  ),
  implemented(
    "flow-persistence",
    "F2.4",
    "Flow folders and immutable revisions",
    "Delivered by F2.4; packages/persistence/tests/flow-store.test.ts, flow-runs.test.ts, and flow-yaml.test.ts. flow.yaml round-trips byte for byte, every change writes an immutable revision named by the sha256 of its canonical JSON, runs reference that hash, metadata writes are atomic, a truncated events.jsonl reads with a gap, and the node:sqlite index rebuilt from the folders lists the same catalog; a corrupt manifest is reported and skipped.",
  ),
  implemented(
    "replay-executor",
    "F2.5",
    "Replay executor",
    "Delivered by F2.5 in the engine over the CDP adapter; tests/browser/replay.spec.ts and packages/engine/tests/replay-*.test.ts. Every action, assertion, and extraction replays on the fixture into steps.json and summary.json with exit codes 0, 1, and 2; reads poll until the step's deadline (no networkidle); a write is dispatched once, and a click whose navigation times out leaves the step indeterminate while the fixture counts exactly one order; pauseReplay holds the next step until resumed; secrets are redacted from every stored file.",
  ),
  implemented(
    "ui-minimal",
    "F2.6",
    "Minimal UI",
    "Delivered by F2.6; tests/e2e/first-flow.spec.ts drives the UI the service serves (Setup, catalog, recorder, editor, and run screens) against Google Chrome on Linux: it records the fixture form, adds assertions with the picker, saves, restarts the service, and replays the flow to passed and to failed with observed vs expected; component tests cover each screen.",
  ),
  implemented(
    "cli-local",
    "F2.7",
    "CLI: open, run, doctor",
    "Delivered by F2.7; tests/contract/cli.test.ts runs the real recnrun binary on a temporary home: open starts or reuses the service and prints the UI URL, doctor --json reports Chrome, DevToolsActivePort (found, not-found, malformed, stale, or unreadable when the operating system blocks the read), bindings, disk, and versions (exit 1 without Chrome), and run prints one JSON summary with exit 0, 1, or 2 for passed, failed, and error. The replay itself is F2.5.",
  ),
  implemented(
    "service-session",
    "F2.6",
    "Service sessions, flows, runs, and picker",
    "Delivered by F2.6a; tests/browser/service-session.spec.ts records the fixture form through the service in Google Chrome, finalizes a flow with fill and click, replays it to passed, and picks the submit button without clicking it; tests/contract/service-session.test.ts covers the commands, the event pushes, and the UI's token meta and CSP over a fake Chrome.",
  ),
  implemented(
    "coverage-loss-accounting",
    "F3.5",
    "Coverage and loss accounting",
    "Delivered by F3.5; tests/browser/coverage.spec.ts bursts 1000 events through a hook that keeps 10 unacknowledged messages, and the buffer-exhausted gaps name every sequence number that never arrived; killing Chrome with SIGKILL mid-run journals a connection-lost gap and cuts the step under way short at once (a read cancelled, a write indeterminate; packages/engine/tests/replay-interrupted.test.ts), so the run is interrupted (exit 2), summary.json names the collector gap, and run.compare reports a collector gap; coverage.json counts events per surface and gaps per reason, and equals the count of the journal. The hook resends what the adapter did not acknowledge; a hole no resend filled is a delivery-lost gap. A document that dies before pagehide can still lose its last unreported messages.",
  ),
  implemented(
    "crash-recovery",
    "F3.6",
    "Crash recovery",
    "Delivered by F3.6; tests/contract/recovery.test.ts kills the service with SIGKILL mid-replay and restarts it on the same home: the run is interrupted (exit 2), the in-flight write step indeterminate, the journal ends with a producer-restarted gap, and nothing is re-executed. A read-only step cut short is cancelled.",
  ),
  implemented(
    "diagnostics-ui",
    "F3.7",
    "Diagnostics timeline",
    "Delivered by F3.7; replays capture their own tabs' network, console, storage, and navigation into the run journal under the step that caused each event. tests/e2e/diagnostics.spec.ts replays a fixture flow, lists the /api/json request with status 500 under step fetch in Requests, has the comparison with ?fail=api-500 name that 500 response at step fetch as the first divergence, and shows an injected gap as a collector gap, never an application failure; tests/contract/run-evidence.test.ts checks the journaled step ids and run.compare's network-status. Causal confidence is labeled; correlation is not proof.",
  ),
  implemented(
    "run-compare-query",
    "F3.8",
    "run.compare and run.queryEvents",
    "Delivered by F3.8; tests/contract/runs-api.test.ts pages run.queryEvents with a cursor that stays valid while the journal grows and filters it by event types, URL origin, profile binding, and time range; run.compare names a different response status as the first divergence, a failed assertion as the application's, and lost events as a collector gap, never the application.",
  ),
  implemented(
    "overhead-benchmark",
    "F3.9",
    "Capture overhead benchmark",
    "Delivered by F3.9; scripts/bench-capture.mjs (vp run bench) compares no instrumentation, Normal, and Deep on the fixture's burst route and reports latency, CPU, memory, events per second, loss, and trace size. tests/browser/bench-smoke.spec.ts runs it for 30 seconds in Docker and asserts that every lost event is accounted as a gap and that the growth of the Node heap over 50 000 captured events stays under its budget. Until the Deep level (F6.5), Deep is Normal with a larger hook buffer and faster cookie reads. The 1 s UI progress and 30-minute recording targets are measurements, not gates; the 30-minute soak (scripts/soak-capture.mjs) is manual (M-F3.a).",
  ),
  {
    kind: "feature",
    id: "events-before-connection",
    title: "Events from before the connection",
    status: "unavailable",
    phase: "F1.2",
    notes:
      "Events that happened before CDP attached are not recoverable and are reported as a gap.",
  },
  {
    kind: "feature",
    id: "video-and-heap-snapshots",
    title: "Full video and heap snapshots",
    status: "unavailable",
    phase: "F3.3",
    notes: "Out of scope: evidence is DOM snapshots and screenshots at milestones.",
  },
];
