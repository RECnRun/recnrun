import { restorableData } from "@recnrun/domain";
import type { IdentityData } from "@recnrun/domain";
import { sampleCapture } from "@recnrun/domain/testing";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { WorkspaceError } from "@/background/workspace/errors";
import { savedStart } from "@/background/workspace/identity-commands";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import { fakeBarrierApi } from "./fake-barrier";
import { chrome, memoryCaptures } from "./fake-capture";
import { fakeCookieApi } from "./fake-cookies";
import { memoryRecordingStore } from "./fake-extension";
import { memoryOperationJournal } from "./fake-journal";
import { fakeNavigationApi } from "./fake-navigation";
import { openWindowsWithTabs } from "./fake-windows";
import { allowIncognito, manageTab } from "./workspace-harness";

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
    const journal = memoryOperationJournal();
    const commands = createWorkspaceCommands(
      memoryRecordingStore(),
      ports(injected("window")),
      journal,
    );
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
    expect(await journal.read()).toEqual(status.operation);
    await commands.start(URL_);
    expect((await commands.status()).operation).toBeUndefined();
  });

  test("recovers an interrupted start before the next status read or command", async () => {
    const journal = memoryOperationJournal({
      id: "op-1",
      kind: "start-with-identity",
      step: "restore",
      status: "running",
      started: 1,
    });
    const commands = createWorkspaceCommands(memoryRecordingStore(), ports(), journal);
    const recovering = commands.recover();
    const status = await commands.status();
    expect(status).toMatchObject({ busy: false, operation: { step: "restore", status: "failed" } });
    await recovering;
    await commands.start(URL_);
    expect(await journal.read()).toBeNull();
  });
});

describe("captureIdentity and startFromCapture", () => {
  const capturing = () => {
    const setup = chrome();
    const captures = memoryCaptures();
    const identities = { api: setup.api, captures, boundMs: 5_000 };
    return { setup, captures, identities };
  };

  test("captures the managed tab only while the workspace is open and allowed", async () => {
    const { setup, captures, identities } = capturing();
    const journal = memoryOperationJournal();
    const commands = createWorkspaceCommands(memoryRecordingStore(), ports(), journal, identities);
    await expect(commands.captureIdentity("identity-a")).rejects.toMatchObject({
      name: "NoManagedWindow",
    });
    await manageTab(7, 9);
    allowIncognito(false);
    await expect(commands.captureIdentity("identity-a")).rejects.toMatchObject({
      name: "IncognitoNotAllowed",
    });
    allowIncognito(true);
    const captured = commands.captureIdentity("identity-a");
    await vi.waitFor(() => expect(setup.agent.posted).toHaveLength(1));
    const { operationId, generation } = setup.agent.posted[0] as Record<string, unknown>;
    expect(generation).toBe(1);
    const store = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
    for (const reply of [
      { type: "capture-database", database: { name: "app", version: 1, stores: [store] } },
      { type: "capture-records", database: "app", store: "kv", records: [{ key: 1, value: 1 }] },
      { type: "captured", counts: { databases: 1, records: 1 } },
    ]) {
      setup.agent.onMessage.emit({ ...reply, operationId, generation });
    }
    await expect(captured).resolves.toMatchObject({ databases: 1, records: 1 });
    expect(captures.calls).toEqual(["begin", "append", "publish"]);
  });

  test("starts from the identity's published capture, and refuses one it does not have", async () => {
    const { captures, identities } = capturing();
    const journal = memoryOperationJournal();
    const commands = createWorkspaceCommands(
      memoryRecordingStore(),
      ports(injected("window")),
      journal,
      identities,
    );
    await expect(commands.startFromCapture("identity-a")).rejects.toMatchObject({
      name: "CaptureMissing",
    });
    const capture = sampleCapture();
    captures.read.mockResolvedValue(capture);
    await expect(savedStart("identity-a", captures)).resolves.toEqual({
      url: capture.url,
      data: restorableData(capture),
    });
    await expect(commands.startFromCapture("identity-a")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(await journal.read()).toMatchObject({ kind: "start-with-identity", step: "window" });
    expect(captures.read).toHaveBeenCalledWith("identity-a");
  });
});
