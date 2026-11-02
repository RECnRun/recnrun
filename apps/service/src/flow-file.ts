import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFlowYaml } from "@recnrun/persistence";
import type { Flow } from "@recnrun/protocol";

/** Reads and validates a flow from a flow folder (its flow.yaml) or a `.flow.json`/`.yaml` file. */
export async function loadFlowFile(path: string): Promise<Flow> {
  let file = path;
  try {
    if ((await stat(path)).isDirectory()) file = join(path, "flow.yaml");
  } catch {
    throw new Error(`${path}: no such flow folder or file.`);
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`${file}: cannot read the flow (a flow folder holds a flow.yaml).`);
  }
  // JSON is YAML, so one parser reads both forms.
  return parseFlowYaml(file, text);
}
