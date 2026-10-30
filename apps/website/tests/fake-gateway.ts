import type { RecordingStatus, Step, Workflow } from "@recnrun/domain";
import type { ExtensionGateway, StartRequest } from "@/services/extension";

interface Seed {
  workflows?: Workflow[];
  steps?: Step[];
  status?: RecordingStatus;
}

export interface FakeGateway extends ExtensionGateway {
  /** Pushes a `stepRecorded` event to every subscriber. */
  emitStep: (step: Step) => void;
  emitStatus: (status: RecordingStatus) => void;
  calls: Array<{ type: string; payload?: unknown }>;
}

function removeFrom<T>(set: Set<T>, item: T) {
  return () => {
    set.delete(item);
  };
}

/** An installed extension answering from in-memory data. Pass an Error to fail every read. */
export function installedGateway(seed: Seed | Error = {}): FakeGateway {
  const data = seed instanceof Error ? {} : seed;
  let workflows = data.workflows ?? [];
  const steps = data.steps ?? [];
  const stepListeners = new Set<(step: Step) => void>();
  const statusListeners = new Set<(status: RecordingStatus) => void>();
  const calls: FakeGateway["calls"] = [];
  const fail = <T>(type: string, payload?: unknown): Promise<T> | undefined => {
    calls.push(payload === undefined ? { type } : { type, payload });
    return seed instanceof Error ? Promise.reject(seed) : undefined;
  };
  const started = (draft: StartRequest | string) => {
    const workflow = workflows[0];
    if (!workflow) throw new Error(`No workflow to start for ${JSON.stringify(draft)}.`);
    return { status: "recording" as const, workflow };
  };
  return {
    calls,
    emitStep: (step) => stepListeners.forEach((listener) => listener(step)),
    emitStatus: (status) => statusListeners.forEach((listener) => listener(status)),
    detect: async () => ({ status: "installed", extensionVersion: "0.1.0" }),
    status: async () => fail("status") ?? data.status ?? { missingOrigins: [] },
    start: async (draft) => fail("start", draft) ?? started(draft),
    stop: async (id) => {
      await fail("stop", id);
      const workflow = workflows.find((candidate) => candidate.id === id) ?? workflows[0];
      if (!workflow) throw new Error("Nothing is recording.");
      return { ...workflow, status: "stopped" };
    },
    resume: async (id) => fail("resume", id) ?? started(id),
    grantOrigins: async (origins) => fail("grantOrigins", origins) ?? true,
    listWorkflows: async () => fail("listWorkflows") ?? workflows,
    listSteps: async (workflowId) =>
      fail("listSteps", workflowId) ?? steps.filter((step) => step.workflowId === workflowId),
    deleteWorkflow: async (id) => {
      await fail("deleteWorkflow", id);
      workflows = workflows.filter((workflow) => workflow.id !== id);
    },
    onStep: (listener) => {
      stepListeners.add(listener);
      return removeFrom(stepListeners, listener);
    },
    onRecordingChanged: (listener) => {
      statusListeners.add(listener);
      return removeFrom(statusListeners, listener);
    },
  };
}

export const missingGateway: ExtensionGateway = {
  ...installedGateway(new Error("The extension is not installed.")),
  detect: async () => ({ status: "missing" }),
};
