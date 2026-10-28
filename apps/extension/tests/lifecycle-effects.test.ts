import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { chromeLifecycleEffects } from "@/background/workspace/lifecycle-effects";
import { createNeutralWindow } from "@/background/workspace/windows";
import { managedWindowRepository } from "@/storage/managed-window-repository";
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
  const { api, cookies } = chrome(frame);
  const captures = memoryCaptures();
  const deps = { api, cookies, captures, identities: memoryIdentities().repository };
  const journal = memoryOperationJournal();
  return { effects: chromeLifecycleEffects(ports, deps, journal), captures, journal, api };
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
  expect(await chromeSide.windows()).toEqual({ foreign: [] });
  const managed = await createNeutralWindow("a");
  expect(managed.identityId).toBe("a");
  const foreign = await openIncognitoWindow();
  expect(await chromeSide.windows()).toEqual({ managed, foreign: [foreign] });
  await chromeSide.close([managed.windowId, foreign]);
  expect(await chromeSide.windows()).toEqual({ foreign: [] });
});

test("a start journals the bootstrap's steps under the command's kind, in a window of the identity", async () => {
  const { effects: chromeSide, journal } = effects("cookie-store");
  const operation = { id: "op-1", kind: "switch" as const };
  await expect(chromeSide.start(identity("a"), "empty", operation)).rejects.toThrow(
    "Injected at cookie-store.",
  );
  expect(new Set(journal.written.map(({ id, kind }) => `${id} ${kind}`))).toEqual(
    new Set(["op-1 switch"]),
  );
  expect(journal.written.at(-1)).toMatchObject({ step: "cookie-store", status: "failed" });
  expect((await managedWindowRepository.read())?.identityId).toBe("a");
});

test("a start from a capture RECnRun does not have opens no window", async () => {
  const { effects: chromeSide, captures } = effects();
  const operation = { id: "op-1", kind: "resume" as const };
  await expect(chromeSide.start(identity("a"), "capture", operation)).rejects.toMatchObject({
    name: "CaptureMissing",
  });
  expect(captures.read).toHaveBeenCalledWith("a");
  expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
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
