import type { RequestType } from "@recnrun/bridge";
import { sampleStep, sampleWorkflow } from "@recnrun/domain/testing";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createExternalListener,
  createMessageListener,
  createRequestHandler,
  type MessageSender,
} from "@/background/handler";
import type { WorkflowController } from "@/background/workflows";
import { openWorkflowStore } from "@/storage/workflow-store";

const EXTERNAL = ["https://recnrun.com/*", "http://localhost/*"];
const recordStep = vi.fn(async () => undefined);
const controller = {
  status: vi.fn(async () => ({ missingOrigins: [] })),
  start: vi.fn(async () => ({ status: "recording", workflow: sampleWorkflow() })),
  stop: vi.fn(async () => sampleWorkflow()),
  resume: vi.fn(async () => ({ status: "recording", workflow: sampleWorkflow() })),
  grantOrigins: vi.fn(async () => ({ granted: true })),
  deleteWorkflow: vi.fn(async () => undefined),
  recordStep,
} as unknown as WorkflowController;

const store = openWorkflowStore(new IDBFactory());
const dispatch = createRequestHandler({
  extensionVersion: "0.1.0",
  controller,
  store,
});

const pageSender: MessageSender = {
  id: "own-id",
  url: "http://localhost:5173/#/",
  tab: { id: 4, url: "http://localhost:5173/#/", groupId: 7, windowId: 1, status: "complete" },
};
const caller = {
  tab: { id: 4, url: "http://localhost:5173/#/", groupId: 7, windowId: 1, loaded: true },
  dashboardOrigin: "http://localhost:5173",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRequestHandler", () => {
  test("answers ping and reads from the store", async () => {
    await store.putWorkflow(sampleWorkflow());
    await store.appendStep(sampleStep());
    await expect(dispatch("ping", undefined, {})).resolves.toEqual({ extensionVersion: "0.1.0" });
    await expect(dispatch("listWorkflows", undefined, {})).resolves.toEqual([sampleWorkflow()]);
    await expect(dispatch("listSteps", { workflowId: "wf-login" }, {})).resolves.toEqual([
      sampleStep(),
    ]);
  });

  test("passes validated payloads and the caller to the controller", async () => {
    const payload = { title: "Login", tags: ["env:local"] };
    await expect(dispatch("startWorkflow", payload, caller)).resolves.toMatchObject({
      status: "recording",
    });
    expect(controller.start).toHaveBeenCalledWith(payload, caller);
    await dispatch("stopWorkflow", undefined, caller);
    expect(controller.stop).toHaveBeenCalledWith(undefined, caller);
    await dispatch("resumeWorkflow", { id: "wf-login" }, caller);
    expect(controller.resume).toHaveBeenCalledWith({ id: "wf-login" }, caller);
    await dispatch("grantOrigins", { origins: ["http://localhost/*"] }, caller);
    expect(controller.grantOrigins).toHaveBeenCalledWith(
      { origins: ["http://localhost/*"] },
      caller,
    );
    await dispatch("getRecordingStatus", undefined, caller);
    expect(controller.status).toHaveBeenCalledWith(caller);
    await expect(dispatch("deleteWorkflow", { id: "wf-login" }, caller)).resolves.toEqual({
      deleted: true,
    });
    expect(controller.deleteWorkflow).toHaveBeenCalledWith({ id: "wf-login" });
  });

  test("rejects a payload that does not match the request type", async () => {
    await expect(dispatch("startWorkflow", { tags: [] }, caller)).rejects.toThrow(
      "Invalid startWorkflow payload.",
    );
    await expect(dispatch("resumeWorkflow", undefined, caller)).rejects.toThrow("Invalid");
    expect(controller.start).not.toHaveBeenCalled();
  });
});

function listen(
  listener: ReturnType<typeof createMessageListener>,
  message: unknown,
  sender: MessageSender,
) {
  const sendResponse = vi.fn();
  const keepsChannelOpen = listener(message, sender, sendResponse);
  return { keepsChannelOpen, sendResponse };
}

describe("createMessageListener", () => {
  const listener = createMessageListener(dispatch, recordStep, "own-id");

  test("answers this extension's own requests with the caller derived from the sender", async () => {
    const message = { kind: "request", type: "getRecordingStatus" };
    const { keepsChannelOpen, sendResponse } = listen(listener, message, pageSender);
    expect(keepsChannelOpen).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, result: { missingOrigins: [] } }),
    );
    expect(controller.status).toHaveBeenCalledWith(caller);
  });

  test("gives the popup no tab, even when it is open in a tab, so the active tab is used", async () => {
    const popup = { id: "own-id", url: "chrome-extension://own-id/popup.html" };
    listen(listener, { kind: "request", type: "getRecordingStatus" }, popup);
    await vi.waitFor(() => expect(controller.status).toHaveBeenCalledWith({}));
    listen(
      listener,
      { kind: "request", type: "getRecordingStatus" },
      { ...popup, tab: { id: 4, url: popup.url, groupId: 7, windowId: 1, status: "complete" } },
    );
    await vi.waitFor(() => expect(controller.status).toHaveBeenCalledTimes(2));
    expect(controller.status).toHaveBeenLastCalledWith({});
  });

  test("reports failures as error replies", async () => {
    const failing = createMessageListener(
      () => Promise.reject(new Error("Quota exceeded")),
      recordStep,
      "own-id",
    );
    const { sendResponse } = listen(failing, { kind: "request", type: "ping" }, pageSender);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Quota exceeded" }),
    );
  });

  test("routes recorder steps to the controller with the sending tab", () => {
    const step = { ...sampleStep(), id: undefined, workflowId: undefined, tabId: undefined };
    const { keepsChannelOpen } = listen(listener, { kind: "step", step }, pageSender);
    expect(keepsChannelOpen).toBe(false);
    expect(recordStep).toHaveBeenCalledWith(expect.objectContaining({ command: "navigate" }), {
      tabId: 4,
      groupId: 7,
      url: "http://localhost:5173/#/",
    });
  });

  test("ignores other senders, unknown messages, and the old envelope", () => {
    const cases: [unknown, MessageSender][] = [
      [
        { kind: "request", type: "ping" },
        { ...pageSender, id: "another-extension" },
      ],
      [{ kind: "request", type: "deleteEverything" }, pageSender],
      [{ type: "ping" }, pageSender],
      ["ping", pageSender],
      [{ kind: "step", step: { command: "" } }, pageSender],
    ];
    for (const [message, sender] of cases) {
      const { keepsChannelOpen, sendResponse } = listen(listener, message, sender);
      expect(keepsChannelOpen).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
    expect(recordStep).not.toHaveBeenCalled();
  });
});

describe("createExternalListener", () => {
  const listener = createExternalListener(dispatch, EXTERNAL);
  const external: MessageSender = {
    url: "https://recnrun.com/#/",
    tab: { id: 4, url: "https://recnrun.com/#/", groupId: 7, windowId: 1, status: "complete" },
  };

  test("answers control requests from pages on the allowed origins", async () => {
    const message = {
      kind: "request",
      type: "startWorkflow",
      payload: { title: "Login", tags: [] },
    };
    const { keepsChannelOpen, sendResponse } = listen(listener, message, external);
    expect(keepsChannelOpen).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, result: expect.anything() }),
    );
    expect(controller.start).toHaveBeenCalledWith(
      { title: "Login", tags: [] },
      {
        tab: { ...caller.tab, url: "https://recnrun.com/#/" },
        dashboardOrigin: "https://recnrun.com",
      },
    );
  });

  test("ignores other origins, requests without a tab, and types the API does not expose", () => {
    const control = { kind: "request", type: "getRecordingStatus" };
    const cases: [unknown, MessageSender][] = [
      [control, { ...external, url: "https://evil.local/" }],
      [control, { url: "https://recnrun.com/" }],
      [{ kind: "request", type: "listSteps", payload: { workflowId: "wf-login" } }, external],
      [
        { kind: "request", type: "grantOrigins", payload: { origins: ["http://localhost/*"] } },
        external,
      ],
      [{ kind: "step", step: sampleStep() }, external],
    ];
    for (const [message, sender] of cases) {
      const { keepsChannelOpen, sendResponse } = listen(listener, message, sender);
      expect(keepsChannelOpen).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
    expect(controller.status).not.toHaveBeenCalled();
    expect(recordStep).not.toHaveBeenCalled();
  });

  test("exposes exactly the control types", () => {
    const exposed: RequestType[] = [
      "getRecordingStatus",
      "startWorkflow",
      "stopWorkflow",
      "resumeWorkflow",
    ];
    for (const type of exposed) {
      const { keepsChannelOpen } = listen(listener, { kind: "request", type }, external);
      expect(keepsChannelOpen).toBe(true);
    }
  });
});
