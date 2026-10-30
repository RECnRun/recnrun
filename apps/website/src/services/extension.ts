import { createBridgeClient, createWindowTransport } from "@recnrun/bridge";
import type { Detection } from "@recnrun/bridge";
import type { RecordingStatus, StartResult, Step, Workflow, WorkflowDraft } from "@recnrun/domain";

export type ExtensionDetection = Detection;
export type StartRequest = WorkflowDraft & { url?: string };

/** The website's only door to the extension. Listeners return an unsubscribe function. */
export interface ExtensionGateway {
  detect: () => Promise<ExtensionDetection>;
  status: () => Promise<RecordingStatus>;
  start: (draft: StartRequest) => Promise<StartResult>;
  stop: (id?: string) => Promise<Workflow>;
  resume: (id: string) => Promise<StartResult>;
  grantOrigins: (origins: string[]) => Promise<boolean>;
  listWorkflows: () => Promise<Workflow[]>;
  listSteps: (workflowId: string) => Promise<Step[]>;
  deleteWorkflow: (id: string) => Promise<void>;
  onStep: (listener: (step: Step) => void) => () => void;
  onRecordingChanged: (listener: (status: RecordingStatus) => void) => () => void;
  onWorkflowChanged: (listener: (workflow: Workflow) => void) => () => void;
}

export function createExtensionGateway(options: { timeoutMs?: number } = {}): ExtensionGateway {
  const client = createBridgeClient(createWindowTransport(), options);
  return {
    detect: () => client.detect(),
    status: () => client.request("getRecordingStatus"),
    start: (draft) => client.request("startWorkflow", draft),
    stop: (id) => client.request("stopWorkflow", id === undefined ? {} : { id }),
    resume: (id) => client.request("resumeWorkflow", { id }),
    grantOrigins: async (origins) => (await client.request("grantOrigins", { origins })).granted,
    listWorkflows: () => client.request("listWorkflows"),
    listSteps: (workflowId) => client.request("listSteps", { workflowId }),
    deleteWorkflow: async (id) => {
      await client.request("deleteWorkflow", { id });
    },
    onStep: (listener) => client.subscribe("stepRecorded", listener),
    onRecordingChanged: (listener) => client.subscribe("recordingChanged", listener),
    onWorkflowChanged: (listener) => client.subscribe("workflowChanged", listener),
  };
}
