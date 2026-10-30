import { REQUESTS } from "@recnrun/bridge";
import type { RequestPayload, RequestResult, RequestType } from "@recnrun/bridge";
import type { StepDraft } from "@recnrun/domain";
import * as v from "valibot";
import { BackgroundMessageSchema, ExternalRequestSchema } from "@/messaging/background-protocol";
import type { BackgroundReply } from "@/messaging/background-protocol";
import type { WorkflowStore } from "@/storage/workflow-store";
import { toTabInfo } from "./browser-adapter.ts";
import type { TabLike } from "./browser-adapter.ts";
import { originOf, urlMatches } from "./origin-patterns.ts";
import type { Caller, StepSender, WorkflowController } from "./workflows.ts";

export interface HandlerDependencies {
  extensionVersion: string;
  controller: WorkflowController;
  store: WorkflowStore;
}

export type Dispatch = (type: RequestType, payload: unknown, caller: Caller) => Promise<unknown>;

type Handlers = {
  [T in RequestType]: (payload: RequestPayload<T>, caller: Caller) => Promise<RequestResult<T>>;
};

/** One dispatcher for the content script, the popup, and the public API. */
export function createRequestHandler(deps: HandlerDependencies): Dispatch {
  const { extensionVersion, controller, store } = deps;
  const handlers: Handlers = {
    ping: async () => ({ extensionVersion }),
    getRecordingStatus: (_, caller) => controller.status(caller),
    startWorkflow: (payload, caller) => controller.start(payload, caller),
    stopWorkflow: (payload, caller) => controller.stop(payload, caller),
    resumeWorkflow: (payload, caller) => controller.resume(payload, caller),
    grantOrigins: (payload, caller) => controller.grantOrigins(payload, caller),
    listWorkflows: () => store.listWorkflows(),
    listSteps: ({ workflowId }) => store.listSteps(workflowId),
    deleteWorkflow: async (payload) => {
      await controller.deleteWorkflow(payload);
      return { deleted: true };
    },
  };
  return <T extends RequestType>(type: T, payload: unknown, caller: Caller) => {
    const parsed = v.safeParse(REQUESTS[type].payload, payload);
    if (!parsed.success) return Promise.reject(new Error(`Invalid ${type} payload.`));
    return handlers[type](parsed.output as RequestPayload<T>, caller);
  };
}

/** The part of `runtime.MessageSender` the listeners read. */
export interface MessageSender {
  id?: string;
  url?: string;
  tab?: TabLike;
}

type Listener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (reply: BackgroundReply) => void,
) => boolean;

function callerOf(sender: MessageSender): Caller {
  const tab = sender.tab && toTabInfo(sender.tab);
  if (!tab) return {};
  const dashboardOrigin = originOf(sender.url);
  return dashboardOrigin === undefined ? { tab } : { tab, dashboardOrigin };
}

function reply(work: Promise<unknown>, sendResponse: (reply: BackgroundReply) => void): true {
  work.then(
    (result) => sendResponse({ ok: true, result }),
    (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}

/** `runtime.onMessage`: this extension's own content script, popup, and recorder. */
export function createMessageListener(
  dispatch: Dispatch,
  recordStep: (draft: StepDraft, sender: StepSender) => Promise<unknown>,
  extensionId: string,
): Listener {
  return (message, sender, sendResponse) => {
    const parsed = v.safeParse(BackgroundMessageSchema, message);
    if (sender.id !== extensionId || !parsed.success) return false;
    if (parsed.output.kind === "request") {
      return reply(
        dispatch(parsed.output.type, parsed.output.payload, callerOf(sender)),
        sendResponse,
      );
    }
    const tab = sender.tab && toTabInfo(sender.tab);
    if (tab) {
      recordStep(parsed.output.step, { tabId: tab.id, groupId: tab.groupId, url: tab.url }).catch(
        () => undefined,
      );
    }
    return false;
  };
}

/** `runtime.onMessageExternal`: pages on the allowed origins, control requests only. */
export function createExternalListener(dispatch: Dispatch, allowedPatterns: string[]): Listener {
  return (message, sender, sendResponse) => {
    const parsed = v.safeParse(ExternalRequestSchema, message);
    if (!parsed.success || !sender.tab || !urlMatches(sender.url, allowedPatterns)) return false;
    return reply(
      dispatch(parsed.output.type, parsed.output.payload, callerOf(sender)),
      sendResponse,
    );
  };
}
