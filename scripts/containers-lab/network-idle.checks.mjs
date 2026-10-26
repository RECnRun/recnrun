// Unit checks for the pending-request tracker the swap mode waits on: a tab is idle once every
// request it started completed or failed, and a wait gives up after its timeout with what is left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingOf, startNetworkIdle, waitForIdle } from "./extension/network-idle.js";

const listeners = {};
globalThis.chrome = {
  webRequest: Object.fromEntries(
    ["onBeforeRequest", "onCompleted", "onErrorOccurred"].map((name) => [
      name,
      { addListener: (listener) => (listeners[name] = listener) },
    ]),
  ),
};
startNetworkIdle();
const request = (requestId, tabId, url = `http://app.localhost/${requestId}`) =>
  listeners.onBeforeRequest({ requestId, tabId, url, type: "xmlhttprequest" });

await test("a tab with no request in flight is idle at once", async () => {
  const settled = await waitForIdle(1, 50);
  assert.deepEqual(settled, { ms: settled.ms, awaited: [], pending: [], timedOut: false });
});

await test("a wait ends when the tab's last request completes or fails", async () => {
  request("r1", 2);
  request("r2", 2);
  request("r3", 3);
  const wait = waitForIdle(2, 1000);
  listeners.onCompleted({ requestId: "r1" });
  listeners.onErrorOccurred({ requestId: "r2" });
  const settled = await wait;
  assert.equal(settled.timedOut, false);
  assert.deepEqual(
    settled.awaited.map(({ url }) => url),
    ["http://app.localhost/r1", "http://app.localhost/r2"],
  );
  assert.deepEqual(
    pendingOf(3).map(({ url }) => url),
    ["http://app.localhost/r3"],
  );
});

await test("a wait gives up after its timeout and reports what is still pending", async () => {
  request("r4", 4);
  const settled = await waitForIdle(4, 20);
  assert.equal(settled.timedOut, true);
  assert.deepEqual(
    settled.pending.map(({ url }) => url),
    ["http://app.localhost/r4"],
  );
  assert.ok(settled.ms >= 20);
  listeners.onCompleted({ requestId: "r4" });
  assert.deepEqual(pendingOf(4), []);
});

await test("a request outside any tab is not tracked", () => {
  request("r5", -1);
  assert.deepEqual(pendingOf(-1), []);
});
