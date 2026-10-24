import type { RecordingSession } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { executeRemote, sharedTabs } from "@/background/remote-commands";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function memory<T>(initial: T | null = null) {
  let value = initial;
  return {
    read: async () => value,
    write: async (next: T | null) => {
      value = next;
    },
  };
}

/** Two normal tabs and an incognito one, in the windows the executor lists. */
async function openTabs() {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const docs = await fakeBrowser.tabs.create({ url: "https://docs.example/", active: true });
  const tab = (fields: Partial<Browser.tabs.Tab>) =>
    ({ windowId: 1, incognito: false, active: false, title: "", ...fields }) as Browser.tabs.Tab;
  vi.spyOn(fakeBrowser.windows, "getAll").mockResolvedValue([
    {
      id: 1,
      focused: true,
      incognito: false,
      alwaysOnTop: false,
      tabs: [
        tab({ id: shop.id, title: "Shop", url: "https://shop.example/" }),
        tab({ id: docs.id, title: "Docs", url: "https://docs.example/", active: true }),
      ],
    },
    {
      id: 2,
      focused: false,
      incognito: true,
      alwaysOnTop: false,
      tabs: [
        tab({ id: 99, windowId: 2, incognito: true, title: "Bank", url: "https://bank.example/" }),
      ],
    },
  ] as never);
  return { shop: shop.id ?? -1, docs: docs.id ?? -1 };
}

function executor(session: RecordingSession | null = null, controller: string | null = null) {
  const sent: { type: string; payload: unknown }[] = [];
  const deps = {
    channel: {
      send: async (type: PeerType, payload: unknown) => {
        sent.push({ type, payload });
        return {} as PeerMessage;
      },
    },
    session: memory(session),
    controller: memory(controller ? { profileId: controller } : null),
  };
  const run = <T extends PeerType>(type: T, payload: PeerPayload<T>, from = PEER) =>
    executeRemote(peerMessage(type, { from, to: ME }, payload), deps as never);
  return { deps, sent, run };
}

const recording = (tabId: number): RecordingSession => ({
  tabId,
  status: "recording",
  banked: 0,
  since: 1,
});

test("shares normal tabs only, never incognito ones", async () => {
  const { shop, docs } = await openTabs();
  const shared = await sharedTabs();
  expect(shared.tabs.map((tab) => tab.id)).toEqual([shop, docs]);
  expect(shared.currentId).toBe(docs);
  expect(JSON.stringify(shared)).not.toContain("bank.example");
});

test("answers a ping, a tab request, and a session request", async () => {
  await openTabs();
  const { sent, run } = executor();
  await run("PING", { timestamp: 1 });
  await run("GET_TABS", {});
  await run("GET_SESSION", {});
  expect(sent.map(({ type }) => type)).toEqual(["PONG", "TABS_SNAPSHOT", "SESSION_STATUS"]);
  expect(sent[2]?.payload).toMatchObject({ session: null, controlledBy: null });
});

test("shows a shared tab, and refuses one that is gone", async () => {
  const { shop } = await openTabs();
  const { sent, run } = executor();
  await run("ACTIVATE_TAB", { tabId: shop });
  const [active] = await fakeBrowser.tabs.query({ active: true });
  expect(active?.id).toBe(shop);
  await run("ACTIVATE_TAB", { tabId: 99 });
  expect(sent.map(({ payload }) => payload)).toMatchObject([{ ok: true }, { ok: false }]);
});

test("starts a session for the peer and marks the peer as its controller", async () => {
  const { shop } = await openTabs();
  const { deps, sent, run } = executor();
  await run("SESSION_START", { tabId: shop });
  expect(await deps.session.read()).toMatchObject({ tabId: shop, status: "recording" });
  expect(await deps.controller.read()).toEqual({ profileId: PEER });
  expect(sent.at(-1)).toMatchObject({ type: "COMMAND_RESULT", payload: { ok: true } });
});

test("refuses to start while a local session runs", async () => {
  const { shop, docs } = await openTabs();
  const { deps, sent, run } = executor(recording(docs));
  await run("SESSION_START", { tabId: shop });
  expect(await deps.session.read()).toEqual(recording(docs));
  expect(sent.at(-1)?.payload).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/already/),
  });
});

test("pauses, resumes, and stops only the session its controller started", async () => {
  const { shop } = await openTabs();
  const { deps, sent, run } = executor(recording(shop), PEER);
  await run("SESSION_SET_STATUS", { status: "paused" });
  expect(await deps.session.read()).toMatchObject({ status: "paused" });
  await run("SESSION_SET_STATUS", { status: "paused" });
  expect(await deps.session.read()).toMatchObject({ status: "paused" });
  await run("SESSION_STOP", {}, OTHER);
  expect(await deps.session.read()).not.toBeNull();
  await run("SESSION_STOP", {});
  expect(await deps.session.read()).toBeNull();
  expect(await deps.controller.read()).toBeNull();
  expect(sent.map(({ payload }) => (payload as { ok: boolean }).ok)).toEqual([
    true,
    true,
    false,
    true,
  ]);
});

test("refuses to change a session that does not run or that it did not start", async () => {
  await openTabs();
  const idle = executor();
  await idle.run("SESSION_STOP", {});
  expect(idle.sent.at(-1)?.payload).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/No session/),
  });
  const local = executor(recording(1));
  await local.run("SESSION_SET_STATUS", { status: "paused" });
  expect(await local.deps.session.read()).toMatchObject({ status: "recording" });
  expect(local.sent.at(-1)?.payload).toMatchObject({ ok: false });
});

test("reports a command that throws as refused", async () => {
  const { shop } = await openTabs();
  const { deps, sent, run } = executor();
  deps.session.write = async () => {
    throw new Error("Storage is full.");
  };
  await run("SESSION_START", { tabId: shop });
  expect(sent.at(-1)?.payload).toMatchObject({ ok: false, reason: "Storage is full." });
});

test("ignores what is only a report", async () => {
  const { sent, run } = executor();
  await run("TABS_CHANGED", { tabs: [] });
  await run("COMMAND_RESULT", { requestId: "x", ok: true });
  expect(sent).toEqual([]);
});
