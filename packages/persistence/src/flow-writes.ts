import { join } from "node:path";
import {
  PROTOCOL_SCHEMA_VERSION,
  type Flow,
  type FlowManifest,
  type FlowStatus,
  type RunManifest,
} from "@recnrun/protocol";
import { writeAtomic } from "./atomic-file.ts";
import { flowEntry, flowPaths, renderRequirements } from "./flow-folders.ts";
import { checkFlow, flowToYaml, parseFlowYaml } from "./flow-yaml.ts";
import type { CatalogIndex } from "./index-db.ts";
import { readRevision, revisionOf, writeRevision } from "./revisions.ts";
import {
  createRunFolder,
  runEntry,
  runFolder,
  writeRunResult,
  type RunHandle,
  type RunResult,
} from "./runs.ts";
import {
  FlowStoreError,
  checkStored,
  readStored,
  readStoredIfPresent,
  readText,
  writeStored,
} from "./store-files.ts";

type FlowPaths = ReturnType<typeof flowPaths>;

/** What the store's writes share: where flows live, the index they keep in sync, and the clock. */
export interface WriteContext {
  flowsRoot: string;
  index: CatalogIndex;
  now: () => Date;
}

/** The outcome of a save: `changed` is false when the flow and status were already current. */
export interface SavedFlow {
  manifest: FlowManifest;
  revision: string;
  changed: boolean;
}

function nextManifest(
  flow: Flow,
  previous: FlowManifest | undefined,
  update: { revision: string; status: FlowStatus; at: string },
): FlowManifest {
  const { revision, status, at } = update;
  const history = previous?.revisions ?? [];
  const revisions =
    previous?.revision === revision ? history : [...history, { revision, savedAt: at }];
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    id: flow.id,
    name: flow.name,
    revision,
    status,
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
    revisions,
  };
}

async function writeFlowFiles(paths: FlowPaths, flow: Flow): Promise<void> {
  await writeAtomic(paths.flow, flowToYaml(flow));
  await writeAtomic(paths.requirements, renderRequirements(flow));
}

/** The revision flow.yaml holds now, "missing" without one, or undefined when it does not parse. */
async function yamlRevision(path: string): Promise<string | undefined> {
  try {
    return revisionOf(parseFlowYaml(path, await readText(path)));
  } catch (error) {
    return error instanceof FlowStoreError && error.code === "not-found" ? "missing" : undefined;
  }
}

/** Puts flow.yaml and requirements.md back to the committed flow when a save stopped before its manifest. */
export async function repairFlowFiles(
  paths: FlowPaths,
  flow: Flow,
  revision: string,
): Promise<void> {
  const current = await yamlRevision(paths.flow);
  if (current === undefined || current === revision) return;
  // Only a revision a save already stored is the store's own leftover; any other text is a person's edit.
  const leftover =
    current === "missing" ||
    (await readRevision(paths.folder, current).then(
      () => true,
      () => false,
    ));
  if (leftover) await writeFlowFiles(paths, flow);
}

/** Validates and stores a flow; a change writes a new immutable revision, then the manifest. */
export async function saveFlow(
  context: WriteContext,
  input: unknown,
  status?: FlowStatus,
): Promise<SavedFlow> {
  const flow = checkFlow("flow", input);
  const paths = flowPaths(context.flowsRoot, flow.id);
  const previous = await readStoredIfPresent("flow-manifest", paths.manifest);
  const revision = await writeRevision(paths.folder, flow);
  const nextStatus = status ?? previous?.status ?? "draft";
  if (previous?.revision === revision && previous.status === nextStatus) {
    await repairFlowFiles(paths, flow, revision);
    return { manifest: previous, revision, changed: false };
  }
  const update = { revision, status: nextStatus, at: context.now().toISOString() };
  await writeFlowFiles(paths, flow);
  // The manifest goes last: it is what makes the new revision current.
  const next = nextManifest(flow, previous, update);
  const manifest = await writeStored("flow-manifest", paths.manifest, next);
  context.index.putFlow(flowEntry(manifest));
  context.index.clearProblem(paths.manifest);
  return { manifest, revision, changed: true };
}

/** Stores the committed revision of `flowId` under `copy.id` as a draft with its own history. */
export async function duplicateFlow(
  context: WriteContext,
  flowId: string,
  copy: { id: string; name?: string | undefined },
): Promise<SavedFlow> {
  const source = flowPaths(context.flowsRoot, flowId);
  const manifest = await readStored("flow-manifest", source.manifest);
  const flow = await readRevision(source.folder, manifest.revision);
  const target = flowPaths(context.flowsRoot, copy.id);
  // A copy never adds a revision to another flow's history.
  if ((await readStoredIfPresent("flow-manifest", target.manifest)) !== undefined) {
    throw new FlowStoreError("flow-exists", target.manifest, "a flow with this id already exists");
  }
  return saveFlow(context, { ...flow, id: copy.id, name: copy.name ?? flow.name }, "draft");
}

/** Creates a run of a stored revision and opens its journal. */
export async function createRun(context: WriteContext, input: RunManifest): Promise<RunHandle> {
  const manifest = checkStored("run-manifest", "run manifest", input);
  const { folder } = flowPaths(context.flowsRoot, manifest.flowId);
  await readRevision(folder, manifest.flowRevision);
  const handle = await createRunFolder(folder, manifest);
  context.index.putRun(runEntry(manifest));
  return handle;
}

/** Writes the result files of a run created before, summary last. */
export async function finishRun(context: WriteContext, result: RunResult): Promise<void> {
  const summary = checkStored("run-summary", "run summary", result.summary);
  const folder = runFolder(flowPaths(context.flowsRoot, summary.flowId).folder, summary.runId);
  const manifest = await readStored("run-manifest", join(folder, "manifest.json"));
  const ids = [result.steps.runId, result.coverage.runId, manifest.runId];
  if (ids.some((id) => id !== summary.runId) || manifest.flowId !== summary.flowId) {
    throw new FlowStoreError("invalid", folder, "the result belongs to another run");
  }
  await writeRunResult(folder, result);
  context.index.putRun(runEntry(manifest, summary));
}
