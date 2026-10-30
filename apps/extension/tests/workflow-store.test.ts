import type { Step, Workflow } from "@recnrun/domain";
import { sampleStep, sampleSteps, sampleWorkflow } from "@recnrun/domain/testing";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vite-plus/test";
import { openWorkflowStore, type WorkflowStore } from "@/storage/workflow-store";

const login: Workflow = sampleWorkflow();
const checkout: Workflow = { ...login, id: "wf-checkout", updatedAt: "2026-10-02T14:06:35.000Z" };
const checkoutStep: Step = { ...sampleStep(), id: "step-other", workflowId: "wf-checkout" };

let factory: IDBFactory;
let store: WorkflowStore;

beforeEach(() => {
  factory = new IDBFactory();
  store = openWorkflowStore(factory);
});

test("returns no workflows before anything is stored", async () => {
  await expect(store.listWorkflows()).resolves.toEqual([]);
  await expect(store.getWorkflow("wf-login")).resolves.toBeUndefined();
});

test("stores workflows and lists them newest first", async () => {
  await store.putWorkflow(login);
  await store.putWorkflow(checkout);
  const listed = await store.listWorkflows();
  expect(listed.map((workflow) => workflow.id)).toEqual(["wf-checkout", "wf-login"]);
  await expect(store.getWorkflow("wf-checkout")).resolves.toEqual(checkout);
});

test("replaces a workflow stored under the same id", async () => {
  await store.putWorkflow(login);
  await store.putWorkflow({ ...login, status: "stopped", updatedAt: "2026-10-31T00:00:00.000Z" });
  await expect(store.getWorkflow("wf-login")).resolves.toMatchObject({ status: "stopped" });
  await expect(store.listWorkflows()).resolves.toHaveLength(1);
});

test("appends steps and lists them oldest first per workflow", async () => {
  await store.putWorkflow(login);
  await store.putWorkflow(checkout);
  const steps = sampleSteps();
  for (const step of [...steps].reverse()) await store.appendStep(step);
  await store.appendStep(checkoutStep);
  await expect(store.listSteps("wf-login")).resolves.toEqual(steps);
  await expect(store.listSteps("wf-checkout")).resolves.toEqual([checkoutStep]);
  await expect(store.listSteps("wf-missing")).resolves.toEqual([]);
});

test("deletes a workflow together with its steps", async () => {
  await store.putWorkflow(login);
  await store.putWorkflow(checkout);
  for (const step of sampleSteps()) await store.appendStep(step);
  await store.appendStep(checkoutStep);
  await store.deleteWorkflow("wf-login");
  await expect(store.getWorkflow("wf-login")).resolves.toBeUndefined();
  await expect(store.listSteps("wf-login")).resolves.toEqual([]);
  await expect(store.listWorkflows()).resolves.toEqual([checkout]);
  await expect(store.listSteps("wf-checkout")).resolves.toEqual([checkoutStep]);
});

test("rejects stored workflows that do not match the current schema", async () => {
  await store.putWorkflow(login);
  await corrupt(factory);
  await expect(store.listWorkflows()).rejects.toThrow(/current schema/);
  await expect(store.getWorkflow("wf-login")).rejects.toThrow(/current schema/);
});

async function corrupt(db: IDBFactory): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = db.open("recnrun");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("workflows", "readwrite");
    transaction.objectStore("workflows").put({ id: "wf-login", updatedAt: "later", title: 42 });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
