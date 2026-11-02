import { existsSync } from "node:fs";
import { expect, launchChrome, test } from "./fixtures/chrome.ts";

interface CdpReply {
  id?: number;
  result?: { product?: unknown };
  error?: { message?: string };
}

function browserProduct(wsEndpoint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsEndpoint);
    socket.addEventListener("error", () => reject(new Error(`No CDP WebSocket at ${wsEndpoint}`)));
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    socket.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as CdpReply;
      if (reply.id !== 1) return;
      socket.close();
      const product = reply.result?.product;
      if (typeof product === "string") resolve(product);
      else reject(new Error(`Browser.getVersion failed: ${reply.error?.message ?? "no product"}`));
    });
  });
}

test("launches Chrome and connects through its DevToolsActivePort", async ({
  chrome,
}, testInfo) => {
  console.log(`DevToolsActivePort of ${chrome.version}:\n${chrome.activePort}`);
  await testInfo.attach("DevToolsActivePort", {
    body: chrome.activePort,
    contentType: "text/plain",
  });
  const lines = chrome.activePort.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines.map((line) => line.trim().length > 0)).toEqual([true, true]);
  expect(Number.isInteger(chrome.port) && chrome.port > 0).toBe(true);
  expect(chrome.port).toBe(Number(lines[0]));
  expect(chrome.wsPath).toBe(lines[1]);
  expect(chrome.wsPath).toMatch(/^\/devtools\/browser\//);
  expect(chrome.wsEndpoint).toBe(`ws://127.0.0.1:${chrome.port}${chrome.wsPath}`);

  const product = await browserProduct(chrome.wsEndpoint);
  console.log(`Browser.getVersion product: ${product}`);
  expect(product).toMatch(/^Chrome\/\d+\./);
  expect(Number(/^Chrome\/(\d+)\./.exec(product)?.[1])).toBeGreaterThanOrEqual(144);
  expect(chrome.version).toContain(product.slice("Chrome/".length));
});

test("gives each launch its own user-data dir and removes it on close", async () => {
  const first = await launchChrome();
  await first.close();
  const second = await launchChrome();
  await second.close();
  expect(second.userDataDir).not.toBe(first.userDataDir);
  expect(first.pid).toBeGreaterThan(0);
  expect(existsSync(first.userDataDir)).toBe(false);
  expect(existsSync(second.userDataDir)).toBe(false);
});
