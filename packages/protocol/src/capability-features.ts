import type { Capability } from "./capabilities.ts";

import { planned } from "./capability-planned.ts";

type Feature = Extract<Capability, { kind: "feature" }>;

// Only what F0 delivers is implemented; everything else moves with its own test (PLAN.md §7).
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
  planned(
    "fixture-app",
    "F0.5",
    "Fixture application",
    "Two-origin app for browser tests; marked implemented when F0.5 lands.",
  ),
  planned(
    "chrome-discovery",
    "F1.1",
    "Chrome discovery",
    "Reads DevToolsActivePort; the default-profile remote-debugging dialog stays manual (M-F1).",
  ),
  planned(
    "cdp-connection",
    "F1.2",
    "CDP connection and handshake",
    "Cannot attach to a Chrome that has not enabled remote debugging.",
  ),
  planned(
    "profile-bindings",
    "F1.3",
    "Profiles as bindings",
    "Bindings stay outside flow packages in ~/.recnrun/bindings.json.",
  ),
  planned(
    "instrumentation-order",
    "F1.4",
    "Instrumentation before application scripts",
    "Ordering is proved on Chrome in Docker before any claim.",
  ),
  planned(
    "replay-spike",
    "F1.6",
    "Replay spike",
    "Actions use real input events, never direct value assignment.",
  ),
  planned(
    "custom-locator-path",
    "F1.7",
    "Custom locator function path",
    "Synchronous infinite loops are cut with Runtime.terminateExecution and the outcome is recorded.",
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
