import { createServer } from "node:http";
import type { Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/chrome.ts";
import { EXTENSION_PATH, loadUnpacked } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";

// POC PLAN.md P1.0: the lab runs on an internal Docker network, so nothing reaches a public host.
const PUBLIC_URL = "https://example.com/";
const OFFLINE_ERROR =
  /net::(ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE)/;
const LOOPBACK_BODY = "recnrun loopback control";
const PUBLIC_ADDRESS = { host: "1.1.1.1", port: 443 };
const CONNECT_TIMEOUT_MS = 10_000;

/** Resolves with the socket's error code, `timeout`, or `connected` when a route out exists. */
function tcpOutcome(): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(PUBLIC_ADDRESS);
    const finish = (outcome: string) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
}

/** A no-cors fetch resolves with any response, so only a network failure rejects it. */
function fetchFromWorker(url: string): string {
  return `fetch(${JSON.stringify(url)}, { mode: "no-cors", cache: "no-store" }).then(
    () => "resolved",
    (error) => "rejected: " + error.message,
  )`;
}

interface Loopback {
  server: Server;
  url: string;
}

async function startLoopbackServer(): Promise<Loopback> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(LOOPBACK_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

// Node inside the container is checked too, so the proof does not rest on Chrome alone.
test.describe("the container has no route out", () => {
  test("DNS does not resolve a public name", async () => {
    const outcome = await lookup("example.com").then(
      ({ address }) => `resolved to ${address}`,
      (error: NodeJS.ErrnoException) => `rejected: ${error.code ?? error.message}`,
    );
    console.log(`dns.lookup("example.com"): ${outcome}`);
    expect(outcome).toMatch(/^rejected: /);
  });

  test("a TCP connection to a public address fails", async () => {
    const outcome = await tcpOutcome();
    console.log(`TCP connect to ${PUBLIC_ADDRESS.host}:${PUBLIC_ADDRESS.port}: ${outcome}`);
    expect(outcome).not.toBe("connected");
  });
});

async function newPage(loaded: LoadedExtension): Promise<Page> {
  const [context] = loaded.chrome.browser.contexts();
  if (!context) throw new Error("Chrome has no default context.");
  return context.newPage();
}

test.describe("the lab has no egress", () => {
  let lab: { loaded: LoadedExtension; loopback: Loopback } | undefined;
  const opened = () => {
    if (!lab) throw new Error("beforeAll did not start Chrome and the loopback server.");
    return lab;
  };

  test.beforeAll(async () => {
    const loopback = await startLoopbackServer();
    try {
      lab = { loaded: await loadUnpacked(EXTENSION_PATH), loopback };
    } catch (error) {
      loopback.server.close();
      throw error;
    }
  });

  test.afterAll(async () => {
    if (!lab) return;
    const { loaded, loopback } = lab;
    await loaded.close();
    await new Promise((resolve) => loopback.server.close(resolve));
  });

  test("a page cannot navigate to a public host", async () => {
    const page = await newPage(opened().loaded);
    const failure = await page.goto(PUBLIC_URL).then(
      (response) => `navigated with status ${response?.status()}`,
      (error: Error) => error.message,
    );
    const code = OFFLINE_ERROR.exec(failure)?.[1];
    test.info().annotations.push({ type: "net-error", description: code ?? failure });
    console.log(`Navigation to ${PUBLIC_URL}: ${code ?? failure}`);
    expect(failure).toMatch(OFFLINE_ERROR);
  });

  test("the extension's service worker cannot fetch a public host", async () => {
    const outcome = await opened().loaded.evaluateInBackground(fetchFromWorker(PUBLIC_URL));
    console.log(`Service worker fetch of ${PUBLIC_URL}: ${String(outcome)}`);
    expect(outcome).toMatch(/^rejected: /);
  });

  test("the loopback and CDP still answer, so the failures above come from the sandbox", async () => {
    const { loaded, loopback } = opened();
    const { product } = await loaded.chrome.cdp.send("Browser.getVersion");
    expect(product).toMatch(/^Chrome\//);
    const page = await newPage(loaded);
    const response = await page.goto(loopback.url);
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toHaveText(LOOPBACK_BODY);
    expect(await loaded.evaluateInBackground(fetchFromWorker(loopback.url))).toBe("resolved");
  });
});
