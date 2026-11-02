import type { Capability } from "./capabilities.ts";
import { planned } from "./capability-planned.ts";

// Editor, functions, agents, and distribution: nothing here is built before F4.
export const ROADMAP_CAPABILITIES: Extract<Capability, { kind: "feature" }>[] = [
  planned(
    "full-editor",
    "F4.1",
    "Full flow editor",
    "Every change creates a revision and past runs keep theirs.",
  ),
  planned(
    "inputs-datasets",
    "F4.2",
    "Inputs, datasets, and variables",
    "Datasets never hold secrets.",
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
