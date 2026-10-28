import type { IdentityData } from "@recnrun/domain";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { WorkspaceError } from "@/background/workspace/errors";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import { fakeBarrierApi } from "./fake-barrier";
import { fakeCookieApi } from "./fake-cookies";
import { memoryRecordingStore } from "./fake-extension";
import { fakeNavigationApi } from "./fake-navigation";
import { openWindowsWithTabs } from "./fake-windows";
import { allowIncognito } from "./workspace-harness";

const URL_ = "http://app.localhost:5192/app/";
const DATA: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [] },
};

function ports(beforeStep: (step: string) => Promise<void> = async () => {}) {
  return {
    cookies: fakeCookieApi([[{ id: "0", tabIds: [1] }]], [1]),
    navigation: fakeNavigationApi(),
    barrier: fakeBarrierApi(),
    hooks: { beforeStep },
  };
}

const injected = (at: string) => async (step: string) => {
  if (step === at) throw new WorkspaceError("InjectedFailure", `Injected at ${step}.`);
};

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  allowIncognito(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startWithIdentity", () => {
  test("refuses a target that is not a web page, without access, or while recording", async () => {
    const store = memoryRecordingStore();
    const commands = createWorkspaceCommands(store, ports());
    await expect(commands.startWithIdentity("file:///etc/hosts", DATA)).rejects.toMatchObject({
      name: "TargetNotAllowed",
    });
    allowIncognito(false);
    await expect(commands.startWithIdentity(URL_, DATA)).rejects.toMatchObject({
      name: "IncognitoNotAllowed",
    });
    allowIncognito(true);
    await store.write({ tabId: 3, startedAt: 1 } as never);
    await expect(commands.startWithIdentity(URL_, DATA)).rejects.toMatchObject({
      name: "RecordingInProgress",
    });
  });

  test("shares the one-operation lock with the other workspace commands", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands = createWorkspaceCommands(
      memoryRecordingStore(),
      ports(() => held),
    );
    const starting = commands.startWithIdentity(URL_, DATA);
    await expect(commands.start(URL_)).rejects.toMatchObject({ name: "WorkspaceBusy" });
    expect((await commands.status()).busy).toBe(true);
    release();
    await expect(starting).rejects.toMatchObject({ name: "CookieStoreNotFound" });
  });

  test("reports the failed operation in the status until another command runs", async () => {
    const commands = createWorkspaceCommands(memoryRecordingStore(), ports(injected("window")));
    await expect(commands.startWithIdentity(URL_, DATA)).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    const status = v.parse(WorkspaceStatusSchema, await commands.status());
    expect(status.operation).toMatchObject({
      kind: "start-with-identity",
      step: "window",
      status: "failed",
      error: "Injected at window.",
    });
    await commands.start(URL_);
    expect((await commands.status()).operation).toBeUndefined();
  });
});
