import type { ManagedWindowState } from "@recnrun/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { captureIdentity, chromeCaptureApi } from "@/background/workspace/capture";
import { chrome, memoryCaptures } from "./fake-capture";
import { fakeCookieApi } from "./fake-cookies";
import { fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const URL_ = `${ORIGIN}/app/`;
const MANAGED: ManagedWindowState = { generation: 4, windowId: 9, tabId: 7, status: "active" };
const SENDER = { tab: { id: 7 }, frameId: 0, documentId: "doc-1", origin: ORIGIN };
const BOUND = 5_000;
const KV = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
const DATABASE = { name: "app", version: 3, stores: [KV] };
const RECORDS = [
  { key: 1, value: { at: new Date(0), tags: new Set(["a"]) } },
  { key: 2, value: "plain" },
];

/** The command the agent got, once it got one, with its operation. */
async function commandOf(agent: ReturnType<typeof fakePort>) {
  await vi.waitFor(() => expect(agent.posted).toHaveLength(1));
  const command = agent.posted[0] as { type: string; operationId: string; generation: number };
  return {
    command,
    operation: { operationId: command.operationId, generation: command.generation },
  };
}

/** Starts a capture and answers its command with `replies`, each tagged with the operation. */
async function captureAnswering(replies: object[], setup = chrome(), captures = memoryCaptures()) {
  const capturing = captureIdentity(
    "identity-a",
    MANAGED,
    { api: setup.api, captures, cookies: setup.cookies, boundMs: BOUND },
    { cookieHosts: ["sso.localhost"] },
  );
  const { operation } = await commandOf(setup.agent);
  for (const reply of replies) setup.agent.onMessage.emit({ ...reply, ...operation });
  return { capturing, captures, ...setup };
}

const LOCAL = { theme: "dark", "": "", "ключ 🔑": "värde" };
const SESSION = { tab: "" };
const STORAGE = { type: "capture-storage", localStorage: LOCAL, sessionStorage: SESSION };
const SCHEMA = { type: "capture-database", database: DATABASE };
const PART = { type: "capture-records", database: "app", store: "kv", records: RECORDS };
const COUNTS = { databases: 1, records: 2, localStorage: 3, sessionStorage: 1 };
const capturedWith = (counts: Partial<typeof COUNTS>) => ({
  type: "captured",
  counts: { ...COUNTS, ...counts },
});
const completeReplies = [STORAGE, SCHEMA, PART, capturedWith({})];
const COOKIE = { value: "abc", path: "/", secure: false, httpOnly: true, sameSite: "lax" } as const;
const SID = { ...COOKIE, name: "sid", domain: "app.localhost", hostOnly: true, session: true };
const SITE_SSO = { ...COOKIE, name: "sso", expirationDate: 4_102_444_800 };
const SSO = { ...SITE_SSO, domain: "sso.localhost", hostOnly: true, session: false };
const ADS = { ...SID, name: "ads", domain: "other.localhost" };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("captureIdentity", () => {
  test("injects the agent into the tab's document and publishes what it sent", async () => {
    const setup = chrome();
    setup.cookies.jar = [SID, SSO, ADS];
    const { capturing, captures, api, agent, onConnect } = await captureAnswering(
      completeReplies,
      setup,
    );
    const summary = await capturing;
    expect(api.inject).toHaveBeenCalledExactlyOnceWith(7, "doc-1");
    expect(agent.posted[0]).toMatchObject({ type: "capture", generation: 4 });
    expect(captures.calls).toEqual(["begin", "append", "publish"]);
    expect(captures.parts).toEqual([
      { origin: ORIGIN, database: "app", store: "kv", records: RECORDS },
    ]);
    const [started, complete] = captures.headers;
    expect(started).toMatchObject({ identityId: "identity-a", url: URL_, status: "in-progress" });
    expect(complete).toMatchObject({
      id: started?.id,
      formatVersion: 1,
      status: "complete",
      origins: [
        {
          origin: ORIGIN,
          localStorage: LOCAL,
          sessionStorage: SESSION,
          indexedDB: [DATABASE],
          caches: [],
        },
      ],
      capabilities: { cookieHosts: ["sso.localhost"] },
      cookies: [
        { name: "sid", value: "abc", path: "/", secure: false, httpOnly: true, sameSite: "lax" },
        { ...SITE_SSO, host: "sso.localhost" },
      ],
      unsupported: [{ adapter: "cookies", item: "ads on other.localhost/" }],
    });
    expect(complete?.adapters).toEqual([
      { adapter: "localStorage", status: "captured" },
      { adapter: "sessionStorage", status: "captured" },
      { adapter: "indexedDB", status: "captured" },
      { adapter: "cookies", status: "captured" },
      { adapter: "cacheStorage", status: "skipped" },
    ]);
    expect(complete?.valueTypes.toSorted()).toEqual(["Date", "Object", "Set", "primitive"]);
    expect(complete?.endedAt).toBeGreaterThanOrEqual(complete?.startedAt ?? Infinity);
    expect(summary).toMatchObject({
      captureId: started?.id,
      ...COUNTS,
      cookies: 2,
      unsupported: 1,
    });
    expect(agent.disconnected).toBe(true);
    expect(onConnect.listeners.size).toBe(0);
  });

  test("ends every other agent link and waits for the tab's own document", async () => {
    const setup = chrome();
    const stray = fakePort({ ...SENDER, documentId: "doc-0" });
    setup.api.inject.mockImplementation(async () => {
      setup.onConnect.emit({ ...fakePort(SENDER), name: "recnrun-site" });
      setup.onConnect.emit(stray);
      setup.onConnect.emit(setup.agent);
    });
    const { capturing } = await captureAnswering(completeReplies, setup);
    await expect(capturing).resolves.toMatchObject({ records: 2 });
    expect(stray.disconnected).toBe(true);
  });

  test("refuses a tab that shows no web page, before injecting anything", async () => {
    for (const frame of [null, { url: "chrome://newtab/", documentId: "doc-1" }]) {
      const setup = chrome(frame);
      const captures = memoryCaptures();
      await expect(
        captureIdentity("identity-a", MANAGED, { ...setup, captures }),
      ).rejects.toMatchObject({ name: "TargetNotAllowed" });
      expect(setup.api.inject).not.toHaveBeenCalled();
      expect(captures.calls).toEqual([]);
    }
  });
});

describe("a failed capture", () => {
  test("refuses a tab whose cookie store Chrome does not list as Incognito, before injecting", async () => {
    const setup = chrome();
    const captures = memoryCaptures();
    const shared = fakeCookieApi([[{ id: "0", tabIds: [1, 7] }]], [1]);
    await expect(
      captureIdentity("identity-a", MANAGED, { api: setup.api, captures, cookies: shared }),
    ).rejects.toMatchObject({ name: "CookieStoreNotFound" });
    expect(setup.api.inject).not.toHaveBeenCalled();
    expect(captures.calls).toEqual([]);
  });

  test("discards the capture when the cookies cannot be read", async () => {
    const setup = chrome();
    setup.cookies.jar = new Error("No cookie store.");
    const { capturing, captures } = await captureAnswering(completeReplies, setup);
    await expect(capturing).rejects.toMatchObject({
      name: "CookiesNotCaptured",
      message: "Chrome did not list the workspace's cookies.",
    });
    expect(captures.calls).toEqual(["begin", "append", "discard"]);
  });

  test("fails as not connected when the agent does not run or does not connect in time", async () => {
    const refused = chrome();
    refused.api.inject.mockRejectedValue(new Error("Cannot access contents of the page."));
    const deps = { ...refused, captures: memoryCaptures(), boundMs: BOUND };
    await expect(captureIdentity("identity-a", MANAGED, deps)).rejects.toMatchObject({
      name: "AgentNotConnected",
    });

    vi.useFakeTimers();
    const silent = chrome();
    silent.api.inject.mockResolvedValue(undefined);
    const waiting = captureIdentity("identity-a", MANAGED, { ...deps, api: silent.api });
    const failed = expect(waiting).rejects.toMatchObject({ name: "AgentNotConnected" });
    await vi.advanceTimersByTimeAsync(BOUND);
    await failed;
    expect(silent.onConnect.listeners.size).toBe(0);
    expect(deps.captures.calls).toEqual([]);
  });

  test("discards the capture when the page reports a failure, and names its reason", async () => {
    const failed = [{ type: "failed", error: "indexedDB: AbortError" }];
    const { capturing, captures, agent } = await captureAnswering(failed);
    await expect(capturing).rejects.toMatchObject({
      name: "CaptureFailed",
      message: expect.stringContaining("indexedDB: AbortError"),
    });
    expect(captures.calls).toEqual(["begin", "discard"]);
    expect(agent.disconnected).toBe(true);
  });

  test("discards a capture whose counts do not match what arrived", async () => {
    const short = [...completeReplies.slice(0, 3), capturedWith({ records: 3 })];
    const { capturing, captures } = await captureAnswering(short);
    await expect(capturing).rejects.toMatchObject({ name: "CaptureIncomplete" });
    expect(captures.calls).toEqual(["begin", "append", "discard"]);
  });

  test("discards a capture whose Web Storage did not arrive whole, or not at all", async () => {
    for (const replies of [
      [{ ...STORAGE, localStorage: { theme: "dark" } }, SCHEMA, PART, capturedWith({})],
      [STORAGE, SCHEMA, PART, capturedWith({ sessionStorage: 2 })],
      [SCHEMA, PART, capturedWith({})],
    ]) {
      const { capturing, captures } = await captureAnswering(replies);
      await expect(capturing).rejects.toMatchObject({ name: "CaptureIncomplete" });
      expect(captures.publish).not.toHaveBeenCalled();
    }
  });

  test("discards the capture when a part cannot be written, and writes no later part", async () => {
    const captures = memoryCaptures();
    captures.append.mockRejectedValueOnce(
      new DOMException("Quota exceeded.", "QuotaExceededError"),
    );
    const twice = [...completeReplies.slice(0, 3), PART, capturedWith({ records: 4 })];
    const { capturing } = await captureAnswering(twice as object[], chrome(), captures);
    await expect(capturing).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(captures.append).toHaveBeenCalledOnce();
    expect(captures.discard).toHaveBeenCalledOnce();
  });

  test("fails as structured clone unavailable, asking for nothing, when the probe comes back as anything but a Date", async () => {
    // Chrome's default JSON messaging turns the probe into its ISO string, and a Blob into {}.
    const setup = chrome(undefined, (probe) => (probe as Date).toISOString());
    const captures = memoryCaptures();
    const capturing = captureIdentity("identity-a", MANAGED, {
      ...setup,
      captures,
      boundMs: BOUND,
    });
    await expect(capturing).rejects.toMatchObject({ name: "StructuredCloneUnavailable" });
    expect(setup.agent.probes).toHaveLength(1);
    expect(setup.agent.posted).toEqual([]);
    expect(captures.calls).toEqual(["begin", "discard"]);
    expect(setup.agent.disconnected).toBe(true);
  });

  test("discards the capture when the page goes away or stops sending", async () => {
    const gone = await captureAnswering([STORAGE]);
    gone.agent.onDisconnect.emit();
    await expect(gone.capturing).rejects.toMatchObject({ name: "AgentDisconnected" });
    expect(gone.captures.calls).toEqual(["begin", "discard"]);

    vi.useFakeTimers();
    const quiet = { ...chrome(), captures: memoryCaptures() };
    // Awaiting the command itself, since `vi.waitFor` advances fake timers while it polls.
    const echoing = quiet.agent.postMessage;
    const sent = new Promise<{ operationId: string; generation: number }>((resolve) => {
      quiet.agent.postMessage = (message) => {
        echoing(message);
        if ((message as { type: string }).type === "capture") resolve(message as never);
      };
    });
    const capturing = captureIdentity("identity-a", MANAGED, { ...quiet, boundMs: BOUND });
    const { operationId, generation } = await sent;
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    quiet.agent.onMessage.emit({ ...STORAGE, operationId, generation });
    // Each message restarts the bound, so only a full bound of silence ends the capture.
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(quiet.agent.disconnected).toBe(false);
    const stopped = expect(capturing).rejects.toMatchObject({ name: "CaptureTimedOut" });
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(quiet.captures.calls).toEqual(["begin", "discard"]);
  });

  test("a capture the repository refuses to begin fails without publishing", async () => {
    const captures = memoryCaptures();
    captures.begin.mockRejectedValueOnce(new Error("A stored capture does not match its schema."));
    captures.discard.mockRejectedValueOnce(new Error("The capture is not in progress."));
    const setup = chrome();
    const deps = { ...setup, captures, boundMs: BOUND };
    await expect(captureIdentity("", MANAGED, deps)).rejects.toThrow(/does not match/);
    expect(captures.publish).not.toHaveBeenCalled();
    expect(setup.agent.disconnected).toBe(true);
  });
});

describe("chromeCaptureApi", () => {
  test("reads the tab's top frame and injects the agent into that document only", async () => {
    const frame = { url: URL_, documentId: "doc-1", frameId: 0, parentFrameId: -1 };
    const getFrame = vi
      .spyOn(fakeBrowser.webNavigation, "getFrame")
      .mockResolvedValue(frame as never);
    await expect(chromeCaptureApi.topFrame(7)).resolves.toEqual({ url: URL_, documentId: "doc-1" });
    expect(getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    getFrame.mockResolvedValue(null as never);
    await expect(chromeCaptureApi.topFrame(7)).resolves.toBeNull();

    const executeScript = vi
      .spyOn(fakeBrowser.scripting, "executeScript")
      .mockResolvedValue([] as never);
    await chromeCaptureApi.inject(7, "doc-1");
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["doc-1"] },
      files: ["/content-scripts/origin-agent.js"],
    });
    expect(chromeCaptureApi.onConnect).toBe(fakeBrowser.runtime.onConnect);
  });
});
