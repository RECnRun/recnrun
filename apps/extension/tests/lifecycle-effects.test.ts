import { restorableData } from "@recnrun/domain";
import { sampleCapture } from "@recnrun/domain/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { chromeLifecycleEffects } from "@/background/workspace/lifecycle-effects";
import { createNeutralWindow } from "@/background/workspace/windows";
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
  return { effects: chromeLifecycleEffects(ports, deps, journal), captures, journal, api, agent };
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("lists the managed window, with its identity, only while its window is open", async () => {
  const { effects: chromeSide } = effects();
  expect(await chromeSide.windows()).toEqual({ foreign: [], otherTabs: 0 });
  const managed = await createNeutralWindow("a");
  expect(managed.identityId).toBe("a");
  const foreign = await openIncognitoWindow();
  expect(await chromeSide.windows()).toEqual({ managed, foreign: [foreign], otherTabs: 0 });
  // A tab the user opened beside the managed one is counted, the managed one never.
  await fakeBrowser.tabs.create({ windowId: managed.windowId, url: "about:blank" });
  expect(await chromeSide.windows()).toMatchObject({ otherTabs: 1 });
  await chromeSide.close([managed.windowId, foreign]);
  expect(await chromeSide.windows()).toEqual({ foreign: [], otherTabs: 0 });
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
  // The capture's declared hosts, not the identity's, go with the data they were captured from.
  const capture = { ...sampleCapture(), capabilities: { cookieHosts: ["sso.localhost"] } };
  captures.read.mockResolvedValue(capture);
  await expect(chromeSide.load(identity("a"), "capture")).resolves.toEqual({
    from: "capture",
    url: capture.url,
    cookieHosts: ["sso.localhost"],
    data: restorableData(capture),
  });
});

test("a new identity's start carries the hosts it declares", async () => {
  const { effects: chromeSide } = effects();
  const declared = { ...identity("a"), capabilities: { cookieHosts: ["sso.localhost"] } };
  await expect(chromeSide.load(declared, "empty")).resolves.toMatchObject({
    from: "empty",
    url: declared.url,
    cookieHosts: ["sso.localhost"],
  });
});

test("captures the managed tab with the identity's capabilities, and deletes its captures", async () => {
  const { effects: chromeSide, captures, api } = effects(undefined, null);
  const managed = await createNeutralWindow("a");
  await expect(chromeSide.capture(identity("a"), managed)).rejects.toMatchObject({
    name: "TargetNotAllowed",
  });
  expect(api.topFrame).toHaveBeenCalledWith(managed.tabId);
  await chromeSide.removeCaptures("a");
  expect(captures.remove).toHaveBeenCalledWith("a");
});

test("a capture first settles the identity's earlier one, then publishes tentatively", async () => {
  const { effects: chromeSide, captures, agent } = effects();
  const managed = { generation: 1, windowId: 5, tabId: 7, status: "active" as const };
  const capturing = chromeSide.capture(identity("a"), { ...managed, identityId: "a" });
  await vi.waitFor(() => expect(agent.posted).toHaveLength(1));
  const { operationId, generation } = agent.posted[0] as Record<string, unknown>;
  for (const reply of completeReplies) agent.onMessage.emit({ ...reply, operationId, generation });
  await expect(capturing).resolves.toMatchObject({ records: 2 });
  expect(captures.calls.slice(0, 2)).toEqual(["settle", "begin"]);
  expect(captures.settle).toHaveBeenCalledWith("a", "cap-a");
  expect(captures.publish).toHaveBeenCalledWith(captures.headers.at(-1), { tentative: true });
});
