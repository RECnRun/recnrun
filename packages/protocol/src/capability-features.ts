import type { Capability } from "./capabilities.ts";

import { implemented, planned } from "./capability-planned.ts";

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
    "Delivered by F1.3 for two Chrome instances; tests/browser/profiles.spec.ts on Linux in Docker. Storage stays in its binding, each actor runs on its binding, a restart is reported stale, never remapped. Bindings live in ~/.recnrun/bindings.json, never in a flow. Two profiles in one Chrome stay manual (M-F1.c).",
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
  planned(
    "service",
    "F2.1",
    "Local service",
    "Loopback only, bearer token, one instance per user.",
  ),
  planned(
    "sessions-control-leases",
    "F2.2",
    "Sessions, control, and leases",
    "Exclusive control per target with fencing tokens.",
  ),
  planned(
    "normalization",
    "F2.3",
    "Event normalization into steps",
    "Suggested steps keep references to their raw events.",
  ),
  planned(
    "flow-persistence",
    "F2.4",
    "Flow folders and immutable revisions",
    "The SQLite index can always be rebuilt from the folders.",
  ),
  planned("replay-executor", "F2.5", "Replay executor", "Write actions are never retried blindly."),
  planned("ui-minimal", "F2.6", "Minimal UI", "Setup, catalog, recorder, editor, and run screens."),
  planned(
    "cli-local",
    "F2.7",
    "CLI: open, run, doctor",
    "Exit codes 0, 1, and 2 for passed, failed, and error.",
  ),
  planned(
    "coverage-loss-accounting",
    "F3.5",
    "Coverage and loss accounting",
    "Bounded buffers emit explicit gap events instead of dropping silently.",
  ),
  planned(
    "crash-recovery",
    "F3.6",
    "Crash recovery",
    "In-flight write steps become indeterminate and nothing is re-executed.",
  ),
  planned(
    "diagnostics-ui",
    "F3.7",
    "Diagnostics timeline",
    "Causal confidence is labeled; correlation is not proof.",
  ),
  planned(
    "run-compare-query",
    "F3.8",
    "run.compare and run.queryEvents",
    "Paginated and filterable.",
  ),
  planned(
    "overhead-benchmark",
    "F3.9",
    "Capture overhead benchmark",
    "Compares no instrumentation, Normal, and Deep.",
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
