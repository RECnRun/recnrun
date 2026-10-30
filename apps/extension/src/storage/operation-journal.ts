import { WorkspaceOperationSchema } from "@recnrun/domain";
import type { WorkspaceOperation } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import type { OperationJournal } from "@/ports/operation-journal";

// Local storage: an extension reload or a stopped service worker must not lose a running start.
const operationItem = storage.defineItem<unknown>("local:workspace-operation");

async function read(): Promise<WorkspaceOperation | null> {
  const stored = await operationItem.getValue();
  if (stored === null) return null;
  const parsed = v.safeParse(WorkspaceOperationSchema, stored);
  if (!parsed.success) {
    throw new Error("The stored workspace operation does not match the current schema.");
  }
  return parsed.output;
}

/** The workspace operation in progress, or the last one, validated like every stored value. */
export const operationJournal: OperationJournal = {
  read,
  write: (operation) => operationItem.setValue(operation),
  clear: () => operationItem.removeValue(),
  watch: (onChange) => operationItem.watch(() => onChange()),
};
