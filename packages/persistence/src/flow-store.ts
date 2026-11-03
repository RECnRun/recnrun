import { join } from "node:path";
import type {
  Dataset,
  Flow,
  FlowManifest,
  FlowStatus,
  RevisionRecord,
  RunCatalogEntry,
  RunManifest,
} from "@recnrun/protocol";
import { flowPaths, scanFlowFolders } from "./flow-folders.ts";
import {
  createRun,
  duplicateFlow,
  finishRun,
  repairFlowFiles,
  saveFlow,
  type SavedFlow,
  type WriteContext,
} from "./flow-writes.ts";
import { CatalogIndex, type CatalogRows, type FlowCatalog } from "./index-db.ts";
import { readRevision } from "./revisions.ts";
import { readBlob } from "./blobs.ts";
import {
  readRunFolder,
  runBlobs,
  runFolder,
  type RunHandle,
  type RunResult,
  type StoredRun,
} from "./runs.ts";
import { FlowStoreError, readStored, writeStored } from "./store-files.ts";

export type { SavedFlow } from "./flow-writes.ts";

/** The flow revision the manifest commits, with that manifest; `revision` is `manifest.revision`. */
export interface StoredFlow {
  manifest: FlowManifest;
  flow: Flow;
  revision: string;
}

/** The flows of this user in `<home>/.recnrun/flows`, with a rebuildable SQLite catalog. */
export interface FlowStore {
  readonly root: string;
  /** The catalog: every readable flow, and the files the last rebuild skipped. */
  list(): Promise<FlowCatalog>;
  get(flowId: string): Promise<StoredFlow>;
  /** Validates and stores the flow; a change writes a new immutable revision. */
  saveFlow(flow: unknown, options?: { status?: FlowStatus }): Promise<SavedFlow>;
  /** Stores the flow's current revision under a new id as a draft; an existing id is refused. */
  duplicateFlow(
    flowId: string,
    copy: { id: string; name?: string | undefined },
  ): Promise<SavedFlow>;
  /** The revisions the flow went through, oldest first. */
  listRevisions(flowId: string): Promise<RevisionRecord[]>;
  getRevision(flowId: string, revision: string): Promise<Flow>;
  saveDataset(flowId: string, name: string, dataset: Dataset): Promise<void>;
  getDataset(flowId: string, name: string): Promise<Dataset>;
  /** Creates a run of a stored revision and opens its journal; the caller closes it. */
  createRun(manifest: RunManifest): Promise<RunHandle>;
  finishRun(result: RunResult): Promise<void>;
  getRun(flowId: string, runId: string): Promise<StoredRun>;
  /** A blob of the run, checked against its sha256; `BlobStoreError` when it cannot be read. */
  readRunBlob(flowId: string, runId: string, sha256: string): Promise<Buffer>;
  listRuns(flowId?: string): Promise<RunCatalogEntry[]>;
  /** Rebuilds the SQLite catalog from the flow folders. */
  rebuildIndex(): Promise<CatalogRows>;
  close(): void;
}

export interface FlowStoreOptions {
  home: string;
  /** The clock of manifest timestamps; tests pin it. */
  now?: () => Date;
}

/** Reads the committed revision, never flow.yaml, so a save cut short cannot mix two versions. */
async function getFlow(flowsRoot: string, flowId: string): Promise<StoredFlow> {
  const paths = flowPaths(flowsRoot, flowId);
  const manifest = await readStored("flow-manifest", paths.manifest);
  const flow = await readRevision(paths.folder, manifest.revision);
  if (manifest.id !== flowId || flow.id !== flowId) {
    throw new FlowStoreError(
      "invalid",
      paths.manifest,
      `it does not commit a revision of ${flowId}`,
    );
  }
  await repairFlowFiles(paths, flow, manifest.revision);
  return { manifest, flow, revision: manifest.revision };
}

/** Opens the flow store of the user whose home folder is `home`, rebuilding a missing index. */
export async function openFlowStore({
  home,
  now = () => new Date(),
}: FlowStoreOptions): Promise<FlowStore> {
  const root = join(home, ".recnrun");
  const flowsRoot = join(root, "flows");
  const index = new CatalogIndex(join(root, "index.sqlite"));
  const context: WriteContext = { flowsRoot, index, now };
  const paths = (flowId: string) => flowPaths(flowsRoot, flowId);
  // One chain per store, so each read-modify-write sees the previous one's result.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = turn.then(work);
    turn = result.catch(() => undefined);
    return result;
  };
  const rebuildIndex = async () => {
    const rows = await scanFlowFolders(flowsRoot);
    index.replace(rows);
    return rows;
  };
  if (index.needsRebuild) await rebuildIndex();
  return {
    root,
    list: async () => index.flows(),
    // Reads join the write queue, so a read never sees a save half done.
    get: (flowId) => exclusive(() => getFlow(flowsRoot, flowId)),
    saveFlow: (flow, options) => exclusive(() => saveFlow(context, flow, options?.status)),
    duplicateFlow: (flowId, copy) => exclusive(() => duplicateFlow(context, flowId, copy)),
    listRevisions: async (flowId) =>
      (await readStored("flow-manifest", paths(flowId).manifest)).revisions,
    getRevision: (flowId, revision) => readRevision(paths(flowId).folder, revision),
    saveDataset: (flowId, name, dataset) =>
      exclusive(async () => {
        await readStored("flow-manifest", paths(flowId).manifest);
        await writeStored("dataset", paths(flowId).dataset(name), dataset);
      }),
    getDataset: (flowId, name) => readStored("dataset", paths(flowId).dataset(name)),
    createRun: (manifest) => exclusive(() => createRun(context, manifest)),
    finishRun: (result) => exclusive(() => finishRun(context, result)),
    getRun: (flowId, runId) => readRunFolder(runFolder(paths(flowId).folder, runId)),
    readRunBlob: (flowId, runId, sha256) =>
      readBlob(runBlobs(runFolder(paths(flowId).folder, runId)), sha256),
    listRuns: async (flowId) => index.runs(flowId),
    rebuildIndex: () => exclusive(rebuildIndex),
    close: () => index.close(),
  };
}
