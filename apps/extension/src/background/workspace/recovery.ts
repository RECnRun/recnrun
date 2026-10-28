import type { WorkspaceOperation } from "@recnrun/domain";
import { barrierOf, removeBarrier } from "@/background/workspace/barrier";
import type { BarrierApi } from "@/background/workspace/barrier";
import { collectFailures } from "@/background/workspace/errors";
import type { OperationJournal } from "@/ports/operation-journal";

export interface RecoveryDeps {
  journal: OperationJournal;
  barrier: BarrierApi;
  /** Closes the window only while it is still the managed window of that generation. */
  closeWindow: (windowId: number, generation: number) => Promise<void>;
}

/** What each command is called in the error a restart leaves, so it names the one interrupted. */
const INTERRUPTED_COMMAND: Record<WorkspaceOperation["kind"], string> = {
  "start-with-identity": "the start",
  switch: "the switch",
  suspend: "the suspension",
  resume: "the resumption",
  "new-identity": "the new identity's creation",
  "delete-identity": "the deletion",
};

const interrupted = ({ kind }: WorkspaceOperation) =>
  `Interrupted: RECnRun restarted before ${INTERRUPTED_COMMAND[kind]} finished.`;

/** Undoes what the interrupted operation may have left: its journaled window, then its barrier. */
async function cleanUp(operation: WorkspaceOperation, deps: RecoveryDeps): Promise<string[]> {
  const { failures, attempt } = collectFailures();
  const { id, generation, windowId } = operation;
  if (generation === undefined) return failures;
  if (windowId !== undefined) await attempt(() => deps.closeWindow(windowId, generation));
  await attempt(() => removeBarrier(barrierOf({ id, generation }), deps.barrier));
  return failures;
}

/**
 * Runs when the service worker starts: an operation still journaled as running died with the
 * previous worker, so it is recorded failed at its step before its window and barrier are removed. Resolves
 * with the failed operation, or undefined when nothing was interrupted.
 */
export async function recoverInterrupted(
  deps: RecoveryDeps,
): Promise<WorkspaceOperation | undefined> {
  const operation = await deps.journal.read();
  if (operation?.status !== "running") return undefined;
  const error = interrupted(operation);
  const failed: WorkspaceOperation = { ...operation, status: "failed", error };
  await deps.journal.write(failed);
  const failures = await cleanUp(operation, deps);
  if (failures.length === 0) return failed;
  const reported = {
    ...failed,
    error: `${error} Cleanup also failed: ${failures.join(" ")}`,
  };
  await deps.journal.write(reported);
  return reported;
}
