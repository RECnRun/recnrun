import { validateFlow, type Flow } from "@recnrun/protocol";
import { parse, stringify } from "yaml";
import { FlowStoreError } from "./store-files.ts";

/** Validates a flow; one with issues is a FlowStoreError listing them. */
export function checkFlow(path: string, input: unknown): Flow {
  const result = validateFlow(input);
  if (result.ok) return result.flow;
  const issues = result.issues.map(
    ({ path: at, message }) => `${at.join(".") || "flow"}: ${message}`,
  );
  throw new FlowStoreError("invalid", path, `not a valid flow (${issues.join("; ")})`);
}

/** The flow as flow.yaml holds it: schema field order, no folded lines, no anchors. */
export function flowToYaml(flow: Flow): string {
  return stringify(flow, { lineWidth: 0, aliasDuplicateObjects: false });
}

/** Reads flow.yaml text back into a validated flow. */
export function parseFlowYaml(path: string, text: string): Flow {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlowStoreError("not-yaml", path, `not YAML (${detail})`);
  }
  return checkFlow(path, document);
}
