import { StepSchema, WorkflowSchema } from "@recnrun/domain";
import type { Step, Workflow } from "@recnrun/domain";
import * as v from "valibot";

const DATABASE = "recnrun";
const VERSION = 1;
const WORKFLOWS = "workflows";
const STEPS = "steps";
const BY_UPDATED_AT = "updatedAt";
const BY_WORKFLOW = "workflowId";

/** Workflows and their steps, in the extension's own IndexedDB database. */
export interface WorkflowStore {
  putWorkflow(workflow: Workflow): Promise<void>;
  getWorkflow(id: string): Promise<Workflow | undefined>;
  /** Newest `updatedAt` first. */
  listWorkflows(): Promise<Workflow[]>;
  /** Deletes the workflow and every step it holds; a missing id is not an error. */
  deleteWorkflow(id: string): Promise<void>;
  appendStep(step: Step): Promise<void>;
  /** Oldest `recordedAt` first. */
  listSteps(workflowId: string): Promise<Step[]>;
}

export function openWorkflowStore(factory: IDBFactory = indexedDB): WorkflowStore {
  const database = openDatabase(factory);
  const run = <T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> => database.then((db) => inTransaction(db, stores, mode, work));

  return {
    putWorkflow: (workflow) =>
      run([WORKFLOWS], "readwrite", async (tx) => {
        await request(tx.objectStore(WORKFLOWS).put(workflow));
      }),
    getWorkflow: (id) =>
      run([WORKFLOWS], "readonly", async (tx) => {
        const stored: unknown = await request(tx.objectStore(WORKFLOWS).get(id));
        return stored === undefined ? undefined : parse(WorkflowSchema, stored);
      }),
    listWorkflows: () =>
      run([WORKFLOWS], "readonly", async (tx) => {
        const stored: unknown = await request(
          tx.objectStore(WORKFLOWS).index(BY_UPDATED_AT).getAll(),
        );
        return parse(v.array(WorkflowSchema), stored).reverse();
      }),
    deleteWorkflow: (id) =>
      run([WORKFLOWS, STEPS], "readwrite", async (tx) => {
        await request(tx.objectStore(WORKFLOWS).delete(id));
        const steps = tx.objectStore(STEPS);
        const keys = await request(steps.index(BY_WORKFLOW).getAllKeys(id));
        await Promise.all(keys.map((key) => request(steps.delete(key))));
      }),
    appendStep: (step) =>
      run([STEPS], "readwrite", async (tx) => {
        await request(tx.objectStore(STEPS).add(step));
      }),
    listSteps: (workflowId) =>
      run([STEPS], "readonly", async (tx) => {
        const stored: unknown = await request(
          tx.objectStore(STEPS).index(BY_WORKFLOW).getAll(workflowId),
        );
        return parse(v.array(StepSchema), stored).sort(byRecordedAt);
      }),
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const opening = factory.open(DATABASE, VERSION);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore(WORKFLOWS, { keyPath: "id" }).createIndex(BY_UPDATED_AT, "updatedAt");
    db.createObjectStore(STEPS, { keyPath: "id" }).createIndex(BY_WORKFLOW, "workflowId");
  };
  return request(opening);
}

function inTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = db.transaction(stores, mode);
  const result = work(transaction);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The transaction was aborted."));
  });
  return result.then(async (value) => {
    await done;
    return value;
  });
}

function byRecordedAt(a: Step, b: Step): number {
  return a.recordedAt.localeCompare(b.recordedAt);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("The database request failed."));
  });
}

/** Storage outlives schema changes, so every read is validated. */
function parse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  stored: unknown,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, stored);
  if (!parsed.success) throw new Error("The stored data does not match the current schema.");
  return parsed.output;
}
