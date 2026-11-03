import { join } from "node:path";
import {
  isId,
  type Flow,
  type FlowCatalogEntry,
  type FlowManifest,
  type StoreProblem,
} from "@recnrun/protocol";
import type { CatalogRows } from "./index-db.ts";
import { scanRuns, subfolders } from "./runs.ts";
import { FlowStoreError, readStored } from "./store-files.ts";

/** The paths of one flow folder, flows/<id>/, named as `flowFolderLayout` lists them. */
export function flowPaths(flowsRoot: string, flowId: string) {
  if (!isId(flowId)) throw new FlowStoreError("not-found", flowId, "a flow id is a slug");
  const folder = join(flowsRoot, flowId);
  return {
    folder,
    flow: join(folder, "flow.yaml"),
    manifest: join(folder, "manifest.json"),
    requirements: join(folder, "requirements.md"),
    dataset: (name: string) => {
      if (!isId(name)) throw new FlowStoreError("not-found", name, "a dataset name is a slug");
      return join(folder, "datasets", `${name}.json`);
    },
  };
}

/** The catalog row of a flow. */
export const flowEntry = (manifest: FlowManifest): FlowCatalogEntry => ({
  id: manifest.id,
  name: manifest.name,
  status: manifest.status,
  revision: manifest.revision,
  updatedAt: manifest.updatedAt,
});

/** requirements.md, written from the flow's requirements on every save. */
export function renderRequirements(flow: Flow): string {
  const lines = flow.requirements.map(({ id, text, source }) =>
    source === undefined ? `- **${id}**: ${text}` : `- **${id}**: ${text} (source: ${source})`,
  );
  const body = lines.length > 0 ? lines.join("\n") : "This flow lists no requirements.";
  return `# Requirements of ${flow.name}\n\n${body}\n`;
}

async function scanFlow(flowsRoot: string, name: string, rows: CatalogRows): Promise<void> {
  const paths = flowPaths(flowsRoot, name);
  const manifest = await readStored("flow-manifest", paths.manifest);
  if (manifest.id !== name) {
    throw new FlowStoreError("invalid", paths.manifest, `its id ${manifest.id} is not its folder`);
  }
  rows.flows.push(flowEntry(manifest));
  rows.runs.push(...(await scanRuns(paths.folder, manifest.id, rows.problems)));
}

/** Reads every flow folder into index rows; an unreadable flow is skipped and reported. */
export async function scanFlowFolders(flowsRoot: string): Promise<CatalogRows> {
  const problems: StoreProblem[] = [];
  const rows: CatalogRows = { flows: [], runs: [], problems };
  for (const name of await subfolders(flowsRoot)) {
    try {
      await scanFlow(flowsRoot, name, rows);
    } catch (error) {
      if (!(error instanceof FlowStoreError)) throw error;
      problems.push(error.toProblem());
    }
  }
  return rows;
}
