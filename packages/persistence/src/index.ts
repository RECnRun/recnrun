/** Names inside a flow folder (source plan §12); F2.4 reads and writes them. */
export const flowFolderLayout = {
  flow: "flow.yaml",
  manifest: "manifest.json",
  requirements: "requirements.md",
  datasets: "datasets",
  revisions: "revisions",
  runs: "runs",
} as const;

export type FlowFolderLayout = typeof flowFolderLayout;

export { BindingsFileError, openBindingsStore, type BindingsStore } from "./bindings-store.ts";
export {
  JournalFileError,
  openJournal,
  readJournal,
  type JournalContents,
  type JournalWriter,
} from "./journal.ts";
export { canonicalJson, canonicalize } from "./canonical.ts";
export {
  openFlowStore,
  type FlowStore,
  type FlowStoreOptions,
  type SavedFlow,
  type StoredFlow,
} from "./flow-store.ts";
export { flowToYaml, parseFlowYaml } from "./flow-yaml.ts";
export type { CatalogRows, FlowCatalog } from "./index-db.ts";
export { revisionOf } from "./revisions.ts";
export type { RunHandle, RunResult, StoredRun } from "./runs.ts";
export { FlowStoreError } from "./store-files.ts";
export {
  openServiceStateStore,
  type LockReading,
  type ServiceStateStore,
} from "./service-state-store.ts";
export { openRotatingLog, type RotatingLog, type RotatingLogOptions } from "./rotating-log.ts";
