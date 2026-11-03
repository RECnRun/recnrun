import { expect, test } from "vite-plus/test";
import { capturing, type ReplyingChannel } from "./capture-harness.ts";
import { within } from "./within.ts";

const URL = "http://127.0.0.1:4600/routes/storage";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieReads = (channel: ReplyingChannel) =>
  channel.methods("S1").filter((method) => method === "Network.getCookies");

/** Chrome answers the storage key and an empty cookie jar. */
function answering(channel: ReplyingChannel): void {
  channel.replies.set("Storage.getStorageKey", { storageKey: "http://127.0.0.1:4600/" });
  channel.replies.set("Network.getCookies", { cookies: [] });
}

test("drain ends the cookie poll first, so a jar that answers slowly cannot hold it", async () => {
  const { channel, handle } = await capturing({ cookiePollMs: 5 });
  answering(channel);
  // Each read outlasts the poll interval, so a read is always under way with another queued.
  const send = channel.send.bind(channel);
  channel.send = (method, params, sessionId) =>
    method === "Network.getCookies"
      ? sleep(20).then(() => send(method, params, sessionId))
      : send(method, params, sessionId);
  channel.attach("S1", { targetId: "T1", type: "page" });
  await sleep(30);
  await within(handle.drain(), 500);
  const reads = cookieReads(channel).length;
  expect(reads).toBeGreaterThan(0);
  await sleep(30);
  expect(cookieReads(channel), "no read starts after the drain").toHaveLength(reads);
});

test("a storage read Chrome never answers ends at the read deadline", async () => {
  const { channel, handle, of } = await capturing({ cookiePollMs: 0, readTimeoutMs: 20 });
  answering(channel);
  channel.holding.add("Storage.getStorageKey");
  channel.holding.add("Network.getCookies");
  channel.attach("S1", { targetId: "T1", type: "page", url: URL }, false);
  await within(handle.drain(), 500);
  expect(of("storage")).toEqual([]);
});

test("a drain that misses its deadline fails naming what was still pending", async () => {
  const { channel, handle } = await capturing({ cookiePollMs: 0 }, { drainTimeoutMs: 20 });
  answering(channel);
  channel.holding.add("Network.getCookies");
  channel.attach("S1", { targetId: "T1", type: "page", url: URL }, false);
  await expect(within(handle.drain(), 500)).rejects.toThrow(
    "Capture did not settle within 20 ms; 1 operation was still pending.",
  );
  handle.stop();
});
