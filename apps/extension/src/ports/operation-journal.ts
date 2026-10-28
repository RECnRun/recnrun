import type { WorkspaceOperation } from "@recnrun/domain";

/** The workspace operation in progress, or the last one, kept where a service-worker restart finds it. */
export interface OperationJournal {
  read: () => Promise<WorkspaceOperation | null>;
  write: (operation: WorkspaceOperation) => Promise<void>;
  clear: () => Promise<void>;
  /** Calls back after any change, from any extension page; returns the unsubscribe function. */
  watch: (onChange: () => void) => () => void;
}
