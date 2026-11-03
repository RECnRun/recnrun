import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  JOURNAL_FILE,
  isId,
  type RunCatalogEntry,
  type RunCoverage,
  type RunManifest,
  type RunSteps,
  type RunSummary,
  type StoreProblem,
} from "@recnrun/protocol";
import { hasCode } from "./atomic-file.ts";
import { openBlobStore, type BlobStore } from "./blobs.ts";
import { openJournal, readJournal, type JournalContents, type JournalWriter } from "./journal.ts";
import { FlowStoreError, readStored, readStoredIfPresent, writeStored } from "./store-files.ts";

/** A run just created: its folder, the open journal of its events, and its blobs. */
export interface RunHandle {
  folder: string;
  manifest: RunManifest;
  journal: JournalWriter;
  blobs: BlobStore;
}

/** The files a finished run adds next to its manifest and journal. */
export interface RunResult {
  steps: RunSteps;
  coverage: RunCoverage;
  summary: RunSummary;
}

/** A run as read back; files a run has not written yet are absent. */
export interface StoredRun {
  manifest: RunManifest;
  steps?: RunSteps;
  coverage?: RunCoverage;
  summary?: RunSummary;
  journal: JournalContents;
}

const RUN_FILES = {
  manifest: "manifest.json",
  steps: "steps.json",
  coverage: "coverage.json",
  summary: "summary.json",
} as const;

/** The folder of a run; the id must be a safe folder name. */
export function runFolder(flowFolder: string, runId: string): string {
  if (!isId(runId)) throw new FlowStoreError("invalid", runId, "a run id is a slug");
  return join(flowFolder, "runs", runId);
}

/** The blob folder of a run: snapshots and screenshots its events reference. */
export const runBlobs = (folder: string): string => join(folder, "blobs");

/** The catalog row of a run: `running` until summary.json exists. */
export const runEntry = (manifest: RunManifest, summary?: RunSummary): RunCatalogEntry => ({
  id: manifest.runId,
  flowId: manifest.flowId,
  revision: manifest.flowRevision,
  status: summary?.status ?? "running",
  startedAt: manifest.startedAt,
  finishedAt: summary?.endedAt ?? null,
});

/** Creates runs/<id>/ with its manifest and opens its journal; an existing run is never reused. */
export async function createRunFolder(
  flowFolder: string,
  manifest: RunManifest,
): Promise<RunHandle> {
  const folder = runFolder(flowFolder, manifest.runId);
  await mkdir(join(flowFolder, "runs"), { recursive: true });
  try {
    await mkdir(folder);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new FlowStoreError("run-exists", folder, "run exists");
    throw error;
  }
  await writeStored("run-manifest", join(folder, RUN_FILES.manifest), manifest);
  const journal = await openJournal(join(folder, JOURNAL_FILE));
  return { folder, manifest, journal, blobs: await openBlobStore({ folder: runBlobs(folder) }) };
}

/** Writes steps, coverage, and last the summary, which marks the run finished. */
export async function writeRunResult(folder: string, result: RunResult): Promise<void> {
  await writeStored("run-steps", join(folder, RUN_FILES.steps), result.steps);
  await writeStored("run-coverage", join(folder, RUN_FILES.coverage), result.coverage);
  await writeStored("run-summary", join(folder, RUN_FILES.summary), result.summary);
}

/** Reads every file of a run; the journal reports a truncated last line as a gap. */
export async function readRunFolder(folder: string): Promise<StoredRun> {
  const manifest = await readStored("run-manifest", join(folder, RUN_FILES.manifest));
  const steps = await readStoredIfPresent("run-steps", join(folder, RUN_FILES.steps));
  const coverage = await readStoredIfPresent("run-coverage", join(folder, RUN_FILES.coverage));
  const summary = await readStoredIfPresent("run-summary", join(folder, RUN_FILES.summary));
  return {
    manifest,
    ...(steps && { steps }),
    ...(coverage && { coverage }),
    ...(summary && { summary }),
    journal: await readJournal(join(folder, JOURNAL_FILE)),
  };
}

async function scanRun(folder: string, flowId: string): Promise<RunCatalogEntry> {
  const path = join(folder, RUN_FILES.manifest);
  const manifest = await readStored("run-manifest", path);
  if (manifest.flowId !== flowId) {
    throw new FlowStoreError("invalid", path, `it belongs to flow ${manifest.flowId}`);
  }
  return runEntry(
    manifest,
    await readStoredIfPresent("run-summary", join(folder, RUN_FILES.summary)),
  );
}

/** Lists the runs of a flow folder for the index, skipping and reporting unreadable ones. */
export async function scanRuns(
  flowFolder: string,
  flowId: string,
  problems: StoreProblem[],
): Promise<RunCatalogEntry[]> {
  const runs: RunCatalogEntry[] = [];
  for (const name of await subfolders(join(flowFolder, "runs"))) {
    try {
      runs.push(await scanRun(runFolder(flowFolder, name), flowId));
    } catch (error) {
      if (!(error instanceof FlowStoreError)) throw error;
      problems.push(error.toProblem());
    }
  }
  return runs;
}

/** The names of the folders inside `path`, sorted; a missing folder has none. */
export async function subfolders(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}
