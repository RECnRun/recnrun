import { HOOK_VERSION, MAX_CAPTURED_TEXT, MAX_STORAGE_ITEMS } from "@recnrun/protocol";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { capturing, DOC, type ReplyingChannel } from "./capture-harness.ts";

const URL = "http://127.0.0.1:4600/routes/storage";
const KEY = "http://127.0.0.1:4600/";
const local = { storageKey: KEY, isLocalStorage: true };
const session = { storageKey: KEY, isLocalStorage: false };
const long = "v".repeat(MAX_CAPTURED_TEXT + 5);

const chromeCookie = (name: string, value: string, flags: Record<string, unknown> = {}) => ({
  name,
  value,
  domain: "127.0.0.1",
  path: "/",
  expires: -1,
  size: name.length + value.length,
  httpOnly: false,
  secure: false,
  session: true,
  priority: "Medium",
  sourceScheme: "NonSecure",
  sourcePort: 4600,
  ...flags,
});

/** Answers the storage reads by area and replays a scripted cookie jar. */
function scriptStorage(channel: ReplyingChannel, jar: { cookies: unknown[] }) {
  channel.replies.set("Storage.getStorageKey", { storageKey: KEY });
  channel.replies.set("Network.getCookies", jar);
  const items = (params: Record<string, unknown> | undefined) => {
    const id = params?.storageId as { isLocalStorage: boolean } | undefined;
    return id?.isLocalStorage
      ? {
          entries: [
            ["theme", "dark"],
            ...Array.from({ length: MAX_STORAGE_ITEMS }, () => ["k", "v"]),
          ],
        }
      : { entries: [["draft", long]] };
  };
  const send = channel.send.bind(channel);
  channel.send = (method, params, sessionId) =>
    method === "DOMStorage.getDOMStorageItems"
      ? send(method, params, sessionId).then(() => items(params))
      : send(method, params, sessionId);
}

const fields = (payload: object) => payload as Record<string, unknown>;

afterEach(() => {
  vi.useRealTimers();
});

test("a captured page also enables DOM storage before it resumes", async () => {
  const { channel, handle } = await capturing({ cookiePollMs: 0 });
  channel.attach("S1", { targetId: "T1", type: "page" });
  await handle.settled();
  expect(channel.methods("S1").slice(-2)).toEqual([
    "DOMStorage.enable",
    "Runtime.runIfWaitingForDebugger",
  ]);
});

test("DOM storage events become observed changes, clipped and flagged", async () => {
  const { channel, of } = await capturing({ cookiePollMs: 0 });
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.emit(
    "DOMStorage.domStorageItemAdded",
    { storageId: local, key: "theme", newValue: long },
    "S1",
  );
  channel.emit(
    "DOMStorage.domStorageItemUpdated",
    { storageId: local, key: "theme", oldValue: "dark", newValue: "light" },
    "S1",
  );
  channel.emit("DOMStorage.domStorageItemRemoved", { storageId: session, key: "draft" }, "S1");
  channel.emit("DOMStorage.domStorageItemsCleared", { storageId: session }, "S1");
  channel.emit("DOMStorage.domStorageItemAdded", { storageId: local, key: 1 }, "S1");
  const change = { observation: "observed-change", storageKey: KEY };
  expect(
    of("storage").map(({ type, component, payload }) => ({ type, component, payload })),
  ).toEqual([
    {
      type: "item-added",
      component: "browser",
      payload: {
        ...change,
        area: "local",
        key: "theme",
        newValue: long.slice(0, MAX_CAPTURED_TEXT),
        truncated: true,
      },
    },
    {
      type: "item-updated",
      component: "browser",
      payload: { ...change, area: "local", key: "theme", oldValue: "dark", newValue: "light" },
    },
    {
      type: "item-removed",
      component: "browser",
      payload: { ...change, area: "session", key: "draft" },
    },
    { type: "items-cleared", component: "browser", payload: { ...change, area: "session" } },
  ]);
});

test("a hooked storage call becomes an observed operation of its document", async () => {
  const { channel, of } = await capturing({ cookiePollMs: 0 });
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.context("S1", 3, "T1");
  channel.post("S1", 3, {
    kind: "lifecycle",
    type: "document.hook-installed",
    payload: { url: URL, hookVersion: HOOK_VERSION },
  });
  const payload = { area: "local", operation: "setItem", key: "theme", value: "dark" };
  channel.post("S1", 3, { kind: "storage", type: "storage.operation", seq: 2, payload });
  expect(of("storage", "operation")).toEqual([
    expect.objectContaining({
      component: "application",
      frameId: "T1",
      documentId: DOC,
      payload: { observation: "observed-operation", ...payload },
    }),
  ]);
});

test("a page hooked late reads a snapshot of its storage and cookies, values redacted", async () => {
  const { channel, handle, of } = await capturing({ cookiePollMs: 0 });
  scriptStorage(channel, {
    cookies: [
      chromeCookie("visible", "plain"),
      chromeCookie("hidden", "s3cr3t", { httpOnly: true }),
      chromeCookie("tls", "s3cr3t", { secure: true, session: false, expires: 1_900_000_000 }),
    ],
  });
  channel.attach("S1", { targetId: "T1", type: "page", url: URL }, false);
  await handle.settled();
  const [localSnapshot, sessionSnapshot] = of("storage", "snapshot");
  expect(localSnapshot?.payload).toMatchObject({
    observation: "snapshot",
    reason: "attach",
    area: "local",
    storageKey: KEY,
    truncated: true,
  });
  expect(localSnapshot?.payload).toHaveProperty("items.length", MAX_STORAGE_ITEMS);
  expect(sessionSnapshot?.payload).toEqual({
    observation: "snapshot",
    reason: "attach",
    area: "session",
    storageKey: KEY,
    items: [{ key: "draft", value: long.slice(0, MAX_CAPTURED_TEXT) }],
    truncated: true,
  });
  const [cookies] = of("storage", "cookies-snapshot");
  expect(cookies?.payload).toEqual({
    observation: "snapshot",
    reason: "attach",
    cookies: [
      {
        name: "visible",
        domain: "127.0.0.1",
        path: "/",
        value: "plain",
        httpOnly: false,
        secure: false,
        session: true,
      },
      {
        name: "hidden",
        domain: "127.0.0.1",
        path: "/",
        redacted: true,
        httpOnly: true,
        secure: false,
        session: true,
      },
      {
        name: "tls",
        domain: "127.0.0.1",
        path: "/",
        redacted: true,
        httpOnly: false,
        secure: true,
        session: false,
        expires: 1_900_000_000,
      },
    ],
  });
  expect(JSON.stringify(of("storage"))).not.toContain("s3cr3t");
});

test("a navigation reads new snapshots; a subframe's leaves the cookies alone", async () => {
  const { channel, handle, of } = await capturing({ cookiePollMs: 0 });
  scriptStorage(channel, { cookies: [] });
  channel.attach("S1", { targetId: "T1", type: "page" });
  await handle.settled();
  expect(of("storage")).toEqual([]);
  channel.emit("Page.frameNavigated", { frame: { id: "T1", url: URL } }, "S1");
  await handle.settled();
  channel.emit(
    "Page.frameNavigated",
    { frame: { id: "F2", parentId: "T1", url: "http://127.0.0.1:4601/routes/frame" } },
    "S1",
  );
  channel.emit(
    "Page.frameNavigated",
    { frame: { id: "F3", parentId: "T1", url: "about:blank" } },
    "S1",
  );
  await handle.settled();
  // Storage and cookie reads answer independently, so only the set of snapshots is fixed.
  const snapshots = of("storage")
    .map(({ type, frameId, payload }) => `${type} ${frameId} ${String(fields(payload).reason)}`)
    .sort((a, b) => a.localeCompare(b));
  expect(snapshots).toEqual([
    "cookies-snapshot T1 navigation",
    "snapshot F2 navigation",
    "snapshot F2 navigation",
    "snapshot T1 navigation",
    "snapshot T1 navigation",
  ]);
});

test("a response that sets cookies reads the jar again and reports what changed", async () => {
  const jar = { cookies: [chromeCookie("a", "1"), chromeCookie("b", "1")] };
  const { channel, handle, of } = await capturing({ cookiePollMs: 0 });
  scriptStorage(channel, jar);
  channel.attach("S1", { targetId: "T1", type: "page", url: URL }, false);
  await handle.settled();
  jar.cookies = [chromeCookie("a", "2"), chromeCookie("c", "s3cr3t", { httpOnly: true })];
  const extra = { requestId: "R1", blockedCookies: [], statusCode: 200 };
  channel.emit(
    "Network.responseReceivedExtraInfo",
    { ...extra, headers: { "content-type": "text/html" } },
    "S1",
  );
  await handle.settled();
  expect(of("storage", "cookie-added")).toEqual([]);
  channel.emit(
    "Network.responseReceivedExtraInfo",
    { ...extra, headers: { "Set-Cookie": "c=x" } },
    "S1",
  );
  await handle.settled();
  const changes = of("storage")
    .filter((event) => event.type.startsWith("cookie-"))
    .map(({ type, payload }) => [type, fields(payload).observation, fields(payload).cookie]);
  expect(changes).toEqual([
    ["cookie-changed", "observed-change", expect.objectContaining({ name: "a", value: "2" })],
    ["cookie-added", "observed-change", expect.objectContaining({ name: "c", redacted: true })],
    ["cookie-removed", "observed-change", expect.objectContaining({ name: "b", value: "1" })],
  ]);
  expect(JSON.stringify(of("storage"))).not.toContain("s3cr3t");
});

test("the cookie jar is polled while the page is attached, and the poll ends with capture", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { channel, handle } = await capturing({ cookiePollMs: 500 });
  scriptStorage(channel, { cookies: [] });
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.attach("I1", { targetId: "F1", type: "iframe" });
  await handle.settled();
  const reads = () => channel.methods("S1").filter((method) => method === "Network.getCookies");
  expect(reads()).toHaveLength(0);
  vi.advanceTimersByTime(1000);
  await handle.settled();
  expect(reads()).toHaveLength(2);
  expect(channel.methods("I1")).not.toContain("Network.getCookies");
  handle.stop();
  vi.advanceTimersByTime(1000);
  expect(reads()).toHaveLength(2);
});
