import type { RequestPayload } from "@recnrun/bridge";
import type { RecordingStatus, StartResult, Step, StepDraft, Workflow } from "@recnrun/domain";
import { readRecordings } from "@/storage/recordings-repository";
import type { TabInfo } from "./browser-adapter.ts";
import { originOf } from "./origin-patterns.ts";
import {
  appendStep,
  begin,
  deleteWorkflow,
  grantOrigins,
  recordNavigation,
  resumeWorkflow,
  statusOf,
  stopById,
  stopGroup,
  sync,
} from "./recording.ts";
import type { Caller, RecordingDependencies } from "./recording.ts";
import { resolveTab } from "./tab-groups.ts";

export type { Caller, RecordingDependencies as ControllerDependencies } from "./recording.ts";

export interface StepSender {
  tabId: number;
  groupId: number;
  url?: string;
}

export interface TabChange {
  url?: string;
  groupId?: number;
  status?: string;
}

/** Start, stop, and resume are shared by the popup, the website, and the public API. */
export interface WorkflowController {
  status: (caller: Caller) => Promise<RecordingStatus>;
  start: (payload: RequestPayload<"startWorkflow">, caller: Caller) => Promise<StartResult>;
  resume: (payload: RequestPayload<"resumeWorkflow">, caller: Caller) => Promise<StartResult>;
  stop: (payload: RequestPayload<"stopWorkflow">, caller: Caller) => Promise<Workflow>;
  grantOrigins: (
    payload: RequestPayload<"grantOrigins">,
    caller: Caller,
  ) => Promise<{ granted: boolean }>;
  deleteWorkflow: (payload: RequestPayload<"deleteWorkflow">) => Promise<void>;
  recordStep: (draft: StepDraft, sender: StepSender) => Promise<Step | undefined>;
  onTabUpdated: (change: TabChange, tab: TabInfo) => Promise<void>;
  onGroupRemoved: (groupId: number) => Promise<void>;
  sync: () => Promise<void>;
}

export function createWorkflowController(deps: RecordingDependencies): WorkflowController {
  const { browser, now, newId } = deps;
  return {
    status: async (caller) =>
      statusOf(deps, await resolveTab(browser, caller), caller.dashboardOrigin),
    start: ({ url, ...draft }, caller) => {
      const createdAt = now();
      const workflow: Workflow = {
        ...draft,
        id: newId(),
        status: "recording",
        createdAt,
        updatedAt: createdAt,
      };
      return begin(deps, workflow, caller, url);
    },
    resume: ({ id }, caller) => resumeWorkflow(deps, id, caller),
    stop: async (payload, caller) => {
      if (payload?.id !== undefined) return stopById(deps, payload.id);
      const tab = await resolveTab(browser, caller);
      const binding = (await readRecordings()).get(tab.groupId);
      if (!binding) throw new Error("This tab group is not recording.");
      return stopGroup(deps, tab.groupId, binding);
    },
    grantOrigins: ({ origins }, caller) => grantOrigins(deps, origins, caller),
    deleteWorkflow: ({ id }) => deleteWorkflow(deps, id),
    recordStep: async (draft, sender) => {
      const binding = (await readRecordings()).get(sender.groupId);
      if (!binding || originOf(sender.url) === binding.dashboardOrigin) return undefined;
      return appendStep(deps, draft, binding, sender.tabId);
    },
    onTabUpdated: async (change, tab) => {
      if (change.groupId !== undefined) await sync(deps);
      if (change.url !== undefined) await recordNavigation(deps, tab, change.url);
    },
    onGroupRemoved: async (groupId) => {
      const binding = (await readRecordings()).get(groupId);
      if (binding) await stopGroup(deps, groupId, binding);
    },
    sync: () => sync(deps),
  };
}
