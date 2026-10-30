import { sampleStep, sampleWorkflow } from "@recnrun/domain/testing";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Caller, WorkflowController } from "@/background/workflows";
import { createWorkflowController } from "@/background/workflows";
import { readRecordings } from "@/storage/recordings-repository";
import { openWorkflowStore, type WorkflowStore } from "@/storage/workflow-store";
import { createFakeBrowser, NO_GROUP, tab, type FakeBrowser } from "./fake-adapter.ts";

const NOW = "2026-10-30T10:00:00.000Z";
const LOCALHOST = "http://localhost/*";
const DASHBOARD = "http://localhost:5173";
const draft = { title: "Log in as admin", tags: ["env:local"] };

let browser: FakeBrowser;
let store: WorkflowStore;
let controller: WorkflowController;
const notify = vi.fn();
let ids = 0;

/** A recnrun dashboard tab (1) and an app tab (2), both ungrouped and on localhost. */
function setUp(
  tabs = [tab({ id: 1, url: `${DASHBOARD}/#/` }), tab({ id: 2 })],
  granted = [LOCALHOST],
) {
  browser = createFakeBrowser(tabs, granted);
  store = openWorkflowStore(new IDBFactory());
  ids = 0;
  controller = createWorkflowController({
    browser,
    store,
    now: () => NOW,
    newId: () => `id-${++ids}`,
    notify,
  });
}

const fromDashboard = (): Caller => ({ tab: browser.tabs[0], dashboardOrigin: DASHBOARD });
const fromPopup = (): Caller => ({});

beforeEach(() => {
  fakeBrowser.reset();
  notify.mockReset();
  setUp();
});

describe("start", () => {
  test("groups the caller's tab, records the workflow, and arms the recorder", async () => {
    const result = await controller.start(draft, fromDashboard());
    const workflow = { ...draft, id: "id-1", status: "recording", createdAt: NOW, updatedAt: NOW };
    expect(result).toEqual({ status: "recording", workflow });
    expect(browser.tabs[0]?.groupId).toBe(100);
    expect(browser.groupTitles.get(100)).toBe("RECnRun");
    await expect(readRecordings()).resolves.toEqual(
      new Map([[100, { workflowId: "id-1", dashboardOrigin: DASHBOARD }]]),
    );
    await expect(store.getWorkflow("id-1")).resolves.toEqual(workflow);
    expect(browser.registered).toEqual([LOCALHOST]);
    expect(notify).toHaveBeenCalledWith(
      { name: "recordingChanged", data: { workflow, missingOrigins: [] } },
      100,
    );
    expect(notify).toHaveBeenCalledWith({ name: "workflowChanged", data: workflow }, undefined);
  });

  test("opens the requested URL inside the group and injects the recorder into loaded tabs", async () => {
    await browser.addToGroup([1, 2], 7);
    await controller.start({ ...draft, url: "http://localhost:4300/start" }, fromDashboard());
    expect(browser.tabs.map((candidate) => [candidate.id, candidate.groupId])).toEqual([
      [1, 7],
      [2, 7],
      [1000, 7],
    ]);
    expect(browser.injected).toEqual([2]);
  });

  test("asks for the missing origins instead of recording", async () => {
    setUp(
      [tab({ id: 1, url: `${DASHBOARD}/#/` }), tab({ id: 2, url: "https://app.example.com/" })],
      [],
    );
    await browser.addToGroup([1, 2], 7);
    const result = await controller.start(
      { ...draft, url: "http://localhost:4300/" },
      fromDashboard(),
    );
    expect(result).toEqual({
      status: "permission-required",
      origins: ["https://app.example.com/*", LOCALHOST],
    });
    await expect(store.listWorkflows()).resolves.toEqual([]);
    expect(browser.tabs).toHaveLength(2);
    expect(browser.registered).toBeUndefined();
  });

  test("refuses a second recording in the same group", async () => {
    await controller.start(draft, fromDashboard());
    await expect(controller.start({ ...draft, title: "Again" }, fromDashboard())).rejects.toThrow(
      'already recording "Log in as admin"',
    );
  });

  test("uses the active tab for the popup and refuses without one", async () => {
    await controller.start(draft, fromPopup());
    await expect(readRecordings()).resolves.toEqual(new Map([[100, { workflowId: "id-1" }]]));
    setUp([]);
    await expect(controller.start(draft, fromPopup())).rejects.toThrow("No active tab");
  });
});

describe("grantOrigins", () => {
  test("asks the person once, then arms the recorder for the granted origins", async () => {
    setUp(undefined, []);
    await browser.addToGroup([1, 2], 7);
    expect(await controller.start(draft, fromDashboard())).toEqual({
      status: "permission-required",
      origins: [LOCALHOST],
    });
    await expect(
      controller.grantOrigins({ origins: [LOCALHOST] }, fromDashboard()),
    ).resolves.toEqual({
      granted: true,
    });
    expect(browser.granted).toEqual(new Set([LOCALHOST]));
    expect(await controller.start(draft, fromDashboard())).toMatchObject({ status: "recording" });
    expect(browser.registered).toEqual([LOCALHOST]);
  });

  test("reports a declined prompt", async () => {
    browser.accepts = false;
    await expect(
      controller.grantOrigins({ origins: [LOCALHOST] }, fromDashboard()),
    ).resolves.toEqual({
      granted: false,
    });
  });
});

describe("stop and resume", () => {
  test("stops the caller's group, unbinds it, and disarms the recorder", async () => {
    await controller.start(draft, fromDashboard());
    const stopped = await controller.stop(undefined, fromDashboard());
    expect(stopped).toMatchObject({ id: "id-1", status: "stopped" });
    await expect(readRecordings()).resolves.toEqual(new Map());
    expect(browser.registered).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      { name: "recordingChanged", data: { missingOrigins: [] } },
      100,
    );
    expect(notify).toHaveBeenLastCalledWith({ name: "workflowChanged", data: stopped }, undefined);
  });

  test("stops by id from anywhere, and returns an already stopped workflow unchanged", async () => {
    await controller.start(draft, fromDashboard());
    await expect(controller.stop({ id: "id-1" }, fromPopup())).resolves.toMatchObject({
      status: "stopped",
    });
    await expect(controller.stop({ id: "id-1" }, fromPopup())).resolves.toMatchObject({
      status: "stopped",
    });
    await expect(controller.stop({ id: "nope" }, fromPopup())).rejects.toThrow("No workflow nope");
    await expect(controller.stop(undefined, fromDashboard())).rejects.toThrow("not recording");
  });

  test("resumes a stopped workflow in the caller's group", async () => {
    await controller.start(draft, fromDashboard());
    await controller.stop(undefined, fromDashboard());
    const result = await controller.resume({ id: "id-1" }, fromDashboard());
    expect(result).toMatchObject({
      status: "recording",
      workflow: { id: "id-1", status: "recording" },
    });
    await expect(readRecordings()).resolves.toEqual(
      new Map([[100, { workflowId: "id-1", dashboardOrigin: DASHBOARD }]]),
    );
    await expect(controller.resume({ id: "id-1" }, fromDashboard())).rejects.toThrow(
      "already recording",
    );
    await expect(controller.resume({ id: "nope" }, fromDashboard())).rejects.toThrow(
      "No workflow nope",
    );
  });
});

describe("status", () => {
  test("reports the group's workflow and the origins still to allow", async () => {
    await expect(controller.status(fromDashboard())).resolves.toEqual({ missingOrigins: [] });
    await controller.start(draft, fromDashboard());
    browser.tabs.push(tab({ id: 3, url: "https://app.example.com/", groupId: 100 }));
    await expect(controller.status(fromDashboard())).resolves.toEqual({
      workflow: expect.objectContaining({ id: "id-1" }),
      missingOrigins: ["https://app.example.com/*"],
    });
  });

  test("reports the missing origin of an ungrouped tab", async () => {
    setUp([tab({ id: 2, url: "https://app.example.com/" })], []);
    await expect(controller.status(fromPopup())).resolves.toEqual({
      missingOrigins: ["https://app.example.com/*"],
    });
  });
});

describe("recordStep", () => {
  const draftStep = {
    recordedAt: NOW,
    url: "http://localhost:4300/login",
    author: "user",
    command: "click",
    selector: "#go",
  } as const;

  test("completes and stores steps from tabs of a recording group", async () => {
    await controller.start(draft, fromDashboard());
    const step = await controller.recordStep(draftStep, {
      tabId: 2,
      groupId: 100,
      url: draftStep.url,
    });
    expect(step).toEqual({ ...draftStep, id: "id-2", workflowId: "id-1", tabId: 2 });
    await expect(store.listSteps("id-1")).resolves.toEqual([step]);
    expect(notify).toHaveBeenCalledWith({ name: "stepRecorded", data: step }, undefined);
  });

  test("ignores steps from other groups and from the dashboard tab", async () => {
    await controller.start(draft, fromDashboard());
    const outside = { tabId: 9, groupId: 55, url: draftStep.url };
    const dashboard = { tabId: 1, groupId: 100, url: `${DASHBOARD}/#/workflows/id-1` };
    await expect(controller.recordStep(draftStep, outside)).resolves.toBeUndefined();
    await expect(controller.recordStep(draftStep, dashboard)).resolves.toBeUndefined();
    await expect(store.listSteps("id-1")).resolves.toEqual([]);
  });
});

describe("browser events", () => {
  test("records navigations and flags origins the recorder cannot reach yet", async () => {
    await controller.start(draft, fromDashboard());
    const moved = tab({ id: 2, url: "https://app.example.com/home", groupId: 100 });
    browser.tabs[1] = moved;
    await controller.onTabUpdated({ url: moved.url }, moved);
    await expect(store.listSteps("id-1")).resolves.toEqual([
      {
        id: "id-2",
        workflowId: "id-1",
        tabId: 2,
        recordedAt: NOW,
        url: "https://app.example.com/home",
        author: "browser",
        command: "navigate",
        value: "https://app.example.com/home",
      },
    ]);
    expect(notify).toHaveBeenLastCalledWith(
      {
        name: "recordingChanged",
        data: {
          workflow: expect.objectContaining({ id: "id-1" }),
          missingOrigins: ["https://app.example.com/*"],
        },
      },
      100,
    );
  });

  test("ignores navigations of the dashboard and of other groups", async () => {
    await controller.start(draft, fromDashboard());
    const dashboard = tab({ id: 1, url: `${DASHBOARD}/#/workflows/id-1`, groupId: 100 });
    await controller.onTabUpdated({ url: dashboard.url }, dashboard);
    await controller.onTabUpdated({ url: "http://localhost:4300/x" }, tab({ id: 9, groupId: 55 }));
    await controller.onTabUpdated({ status: "complete" }, tab({ id: 2, groupId: 100 }));
    await expect(store.listSteps("id-1")).resolves.toEqual([]);
  });

  test("injects the recorder when a tab joins a recording group", async () => {
    await controller.start(draft, fromDashboard());
    browser.injected = [];
    const joined = tab({ id: 3, groupId: 100 });
    browser.tabs.push(joined);
    await controller.onTabUpdated({ groupId: 100 }, joined);
    expect(browser.injected).toContain(3);
  });

  test("stops the recording when its group is closed", async () => {
    await controller.start(draft, fromDashboard());
    await controller.onGroupRemoved(100);
    await expect(store.getWorkflow("id-1")).resolves.toMatchObject({ status: "stopped" });
    await expect(readRecordings()).resolves.toEqual(new Map());
    await controller.onGroupRemoved(123);
  });

  test("sync disarms the recorder when nothing records", async () => {
    browser.registered = [LOCALHOST];
    await controller.sync();
    expect(browser.registered).toBeUndefined();
  });
});

describe("delete", () => {
  test("deletes a stopped workflow and refuses a recording one", async () => {
    await store.putWorkflow({ ...sampleWorkflow(), status: "stopped" });
    await store.appendStep(sampleStep());
    await controller.deleteWorkflow({ id: "wf-login" });
    await expect(store.listWorkflows()).resolves.toEqual([]);
    await expect(store.listSteps("wf-login")).resolves.toEqual([]);
    await controller.start(draft, fromDashboard());
    await expect(controller.deleteWorkflow({ id: "id-1" })).rejects.toThrow("Stop");
    await expect(controller.deleteWorkflow({ id: "nope" })).rejects.toThrow("No workflow nope");
  });
});

test("the caller's group is the tab's group even when it is ungrouped", () => {
  expect(tab({ id: 1 }).groupId).toBe(NO_GROUP);
});
