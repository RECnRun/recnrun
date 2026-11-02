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
