import type { Capability } from "./capabilities.ts";
import { implemented, planned } from "./capability-planned.ts";

// Editor, functions, agents, and distribution: nothing here is built before F4.
export const ROADMAP_CAPABILITIES: Extract<Capability, { kind: "feature" }>[] = [
  implemented(
    "full-editor",
    "F4.1",
    "Full flow editor",
    "Delivered by F4.1; tests/e2e/editor.spec.ts on the real service: steps are added, removed, reordered, and edited in place, assertions and waits are inserted before a chosen step, a target is picked in Chrome from a candidate list, a literal becomes an input, inputs, actors, and requirements are declared and linked, timeouts and the step's actor change, the flow is duplicated, and two revisions are compared. Component tests: apps/ui/tests/editor*.browser.test.tsx. Every save is a new revision and a run keeps the revision it replayed. Locator lists with several strategies and multi-actor runs are F4A.6 and F4.3.",
  ),
  implemented(
    "inputs-datasets",
    "F4.2",
    "Inputs, datasets, and variables",
    "Delivered by F4.2. Typed inputs: a dataset, a run's inputs, and an input's default are checked against the flow's declared inputs (packages/protocol/tests/input-values.test.ts, packages/persistence/tests/flow-store.test.ts, apps/service/tests/runs.test.ts, apps/cli/tests/run.test.ts). Datasets never hold secrets: a secret input's value is refused when a dataset is written or read, and the run form lists, picks, and saves them without secrets (tests/contract/datasets.test.ts, apps/ui/tests/run-datasets.browser.test.tsx). An `authenticated: <actor>` precondition with a URL or visible-element check runs before any step, in the actor's Chrome; an expired session ends the run as `error` with `precondition-failed` and every step blocked (packages/engine/tests/preconditions.test.ts; tests/browser/preconditions.spec.ts on Google Chrome over CDP). Variables have flow scope (`vars`, written by extraction) and block scope (`locals`); a function check and `setVariable` arrive with F4A.3 and F4A.4.",
  ),
  planned(
    "multiple-profiles-actors",
    "F4.3",
    "Multiple profiles and actors",
    "Actors are portable roles; bindings are local.",
  ),
  planned(
    "import-export",
    "F4.4",
    "Flow export and import",
    "Secrets are references and are never serialized.",
  ),
  planned(
    "flow-status-requirements",
    "F4.5",
    "Flow status and requirement coverage",
    "A recording is not validated until a replay passes.",
  ),
  planned(
    "scoped-reset",
    "F4.6",
    "Initial state and scoped reset",
    "Only an authorized origin is reset, as an explicit operation.",
  ),
  planned(
    "locator-lists",
    "F4A.1",
    "Locator lists and cardinality",
    "A second strategy never runs after a dispatched action fails.",
  ),
  planned(
    "function-registry",
    "F4A.2",
    "Custom function registry",
    "Versions are immutable and pinned; no latest during replay.",
  ),
  planned(
    "function-runtimes",
    "F4A.3",
    "Function runtimes",
    "worker_threads isolates state and cancellation but is not a security sandbox.",
  ),
  planned(
    "macros",
    "F4A.4",
    "Macros, loops, and conditionals",
    "Loops need mandatory limits; interruption after an effect is indeterminate.",
  ),
  planned("macro-sdk", "F4A.5", "Macro SDK", "Produces child steps and events with redaction."),
  planned(
    "locator-function-ui",
    "F4A.6",
    "UI for locators, functions, and blocks",
    "Includes extracting a macro from selected steps.",
  ),
  planned(
    "function-export-import",
    "F4A.7",
    "Function export and import",
    "Import never downloads anything.",
  ),
  planned(
    "function-promotion",
    "F4A.8",
    "Promotion to built-in",
    "Exercised once on a generic locator.",
  ),
  planned(
    "mcp-server",
    "F5.1",
    "MCP server",
    "A thin stdio adapter to the service; stdout is reserved for the protocol.",
  ),
  planned(
    "agents-setup",
    "F5.2",
    "Agent setup for Claude Code and Codex",
    "Never overwrites existing configuration and supports undo.",
  ),
  planned(
    "agent-skills",
    "F5.3",
    "Agent skills",
    "A criterion is covered with evidence or not covered, never satisfied by absence of error.",
  ),
  planned("handoff", "F5.4", "Agent handoff", "The in-flight command becomes indeterminate."),
  planned(
    "reproducers",
    "F5.5",
    "Reproducers",
    "Written under regressions/ and runnable as a test.",
  ),
  planned(
    "builtin-migration",
    "F5.7",
    "Built-in promotion with migration",
    "Opt-in; no flow changes silently.",
  ),
  planned(
    "deep-level",
    "F6.5",
    "Deep capture level",
    "Toggled per scenario and measured against Normal.",
  ),
  planned(
    "npm-package",
    "F7.1",
    "npm package",
    "Installs from the tarball on a clean Node container with Chrome.",
  ),
  planned(
    "lifecycle",
    "F7.2",
    "Setup, uninstall, and update",
    "Setup is idempotent and never restarts Chrome.",
  ),
  planned(
    "release-gate",
    "F7.4",
    "Release gate",
    "Manual items M-F1 to M-F7 are recorded before any publish.",
  ),
];
