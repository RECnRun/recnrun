import type { WorkspaceOperation } from "@recnrun/domain";
import type { OperationJournal } from "@/ports/operation-journal";

/** An in-memory journal that keeps every write, in order. */
export function memoryOperationJournal(
  initial: WorkspaceOperation | null = null,
): OperationJournal & { written: WorkspaceOperation[] } {
  let current = initial;
  const written: WorkspaceOperation[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    written,
    read: async () => current,
    write: async (operation) => {
      current = operation;
      written.push(operation);
      changed();
    },
    clear: async () => {
      current = null;
      changed();
    },
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}
