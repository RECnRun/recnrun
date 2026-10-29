import { restorableData } from "@recnrun/domain";
import { sampleCapture } from "@recnrun/domain/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { chromeHelperTabApi } from "@/background/workspace/helper-tab";
import { chromeLifecycleEffects } from "@/background/workspace/lifecycle-effects";
import { exposeResponseUrls } from "@/background/workspace/response-urls";
import { createNeutralWindow } from "@/background/workspace/windows";
import type { ResponseUrls } from "@/ports/response-urls";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { completeReplies } from "./capture-replies";
import { chrome, memoryCaptures } from "./fake-capture";
import { memoryOperationJournal } from "./fake-journal";
import { identity, memoryIdentities } from "./fake-lifecycle";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";
import { fakeWorkspacePorts } from "./workspace-harness";

function effects(failAt?: string, frame?: null) {
  const beforeStep = async (step: string) => {
    if (step === failAt) throw new WorkspaceError("InjectedFailure", `Injected at ${step}.`);
  };
  const ports = { ...fakeWorkspacePorts(), hooks: { beforeStep } };
  const { api, cookies, agent } = chrome(frame);
  const captures = memoryCaptures();
  const deps = { api, cookies, captures, identities: memoryIdentities([identity("a")]).repository };
  const journal = memoryOperationJournal();
  const chromeSide = chromeLifecycleEffects(ports, deps, journal);
  return { effects: chromeSide, ports, captures, journal, api, agent };
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The tab ids of `windowIds`, in window order, as Chrome lists them. */
async function tabsIn(...windowIds: number[]): Promise<number[]> {
  const tabs = await Promise.all(windowIds.map((windowId) => fakeBrowser.tabs.query({ windowId })));
  return tabs.flat().flatMap(({ id }) => (id === undefined ? [] : [id]));
}

test("lists every Incognito window as the session's while it is open, and as foreign otherwise", async () => {
  const { effects: chromeSide } = effects();
  const before = await openIncognitoWindow();
  expect(await chromeSide.windows()).toEqual({ session: [], foreign: [before], tabs: [] });
  await chromeSide.close([before]);
  const managed = await createNeutralWindow("a");
  expect(managed.identityId).toBe("a");
  const beside = await openIncognitoWindow();
  const both = await tabsIn(managed.windowId, beside);
  expect(both).toHaveLength(2);
  expect(await chromeSide.windows()).toEqual({
    managed,
    session: [managed.windowId, beside],
    foreign: [],
    tabs: both,
  });
  // The window RECnRun opened first may go; the session lives on in the other one.
  await chromeSide.close([managed.windowId]);
  expect(await chromeSide.windows()).toEqual({
    managed,
    session: [beside],
    foreign: [],
    tabs: await tabsIn(beside),
  });
  await chromeSide.close([beside]);
  expect(await chromeSide.windows()).toEqual({ session: [], foreign: [], tabs: [] });
});

test("ends the session by unregistering the scripts that showed its responses' URLs", async () => {
  const { effects: chromeSide, ports } = effects();
  const urls: ResponseUrls = {
    "https://app.example": [["https://app.example/a", "https://app.example/a"]],
  };
  await exposeResponseUrls(1, urls, ports);
  expect(ports.barrier.scripts.size).toBe(2);
  await chromeSide.endSession();
  expect(ports.barrier.scripts.size).toBe(0);
});

test("leaves RECnRun's helper tab out of the session's tabs", async () => {
  const { effects: chromeSide } = effects();
  const managed = await createNeutralWindow("a");
  const helper = await chromeHelperTabApi.open(managed.windowId);
  expect((await chromeSide.windows()).tabs).toEqual([managed.tabId]);
  // The fake browser cannot remove a tab of a window it created through the spy; the set is cleared.
  await chromeHelperTabApi.close(helper).catch(() => undefined);
});

test("a start journals the bootstrap's steps under the command's kind, in a window of the identity", async () => {
  const { effects: chromeSide, journal } = effects("cookie-store");
  const operation = { id: "op-1", kind: "switch" as const };
  await expect(
    chromeSide.start(identity("a"), await chromeSide.load(identity("a"), "empty"), operation),
  ).rejects.toThrow("Injected at cookie-store.");
  expect(new Set(journal.written.map(({ id, kind }) => `${id} ${kind}`))).toEqual(
    new Set(["op-1 switch"]),
  );
  expect(journal.written.at(-1)).toMatchObject({ step: "cookie-store", status: "failed" });
  expect((await managedWindowRepository.read())?.identityId).toBe("a");
});

test("loading a start from a capture RECnRun does not have refuses and opens no window", async () => {
  const { effects: chromeSide, captures } = effects();
  await expect(chromeSide.load(identity("a"), "capture")).rejects.toMatchObject({
    name: "CaptureMissing",
  });
  expect(captures.calls).toEqual(["settle"]);
  expect(captures.settle).toHaveBeenCalledWith("a", "cap-a");
  expect(captures.read).toHaveBeenCalledWith("a");
  expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  const capture = sampleCapture();
  captures.read.mockResolvedValue(capture);
  await expect(chromeSide.load(identity("a"), "capture")).resolves.toEqual({
    from: "capture",
    url: capture.url,
    data: restorableData(capture),
  });
});

test("captures the managed tab, and deletes its captures", async () => {
  const { effects: chromeSide, captures, api } = effects(undefined, null);
  const managed = await createNeutralWindow("a");
  const tabs = [{ id: managed.tabId, active: true }];
  api.windows.mockResolvedValue([{ id: managed.windowId, focused: true, tabs }]);
  await expect(chromeSide.capture(identity("a"), managed, "op-7")).rejects.toMatchObject({
    name: "TargetNotAllowed",
  });
  expect(api.topFrame).toHaveBeenCalledWith(managed.tabId);
  await chromeSide.removeCaptures("a");
  expect(captures.remove).toHaveBeenCalledWith("a");
});

test("a capture first settles the identity's earlier one, then publishes tentatively", async () => {
  const { effects: chromeSide, captures, agent } = effects();
  const managed = { generation: 1, windowId: 5, tabId: 7, status: "active" as const };
  const capturing = chromeSide.capture(identity("a"), { ...managed, identityId: "a" }, "op-7");
  await vi.waitFor(() => expect(agent.posted).toHaveLength(1));
  const { operationId, generation } = agent.posted[0] as Record<string, unknown>;
  // The lifecycle's operation names the capture, so a restart's recovery finds its helper barriers.
  expect(operationId).toBe("op-7");
  for (const reply of completeReplies) agent.onMessage.emit({ ...reply, operationId, generation });
  await expect(capturing).resolves.toMatchObject({ records: 2 });
  expect(captures.calls.slice(0, 2)).toEqual(["settle", "begin"]);
  expect(captures.settle).toHaveBeenCalledWith("a", "cap-a");
  expect(captures.publish).toHaveBeenCalledWith(captures.headers.at(-1), { tentative: true });
});
