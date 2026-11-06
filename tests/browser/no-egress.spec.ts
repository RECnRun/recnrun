import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/chrome.ts";
import { EXTENSION_PATH, loadUnpacked } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";

// POC PLAN.md P1.0: the lab runs on an internal Docker network and filters its own egress to lo.
const PUBLIC_URL = "https://example.com/";
const OFFLINE_ERROR =
  /net::(ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE)/;
const LOOPBACK_BODY = "recnrun loopback control";
const PUBLIC_ADDRESS = { host: "1.1.1.1", port: 443 };
const CONNECT_TIMEOUT_MS = 10_000;
// scripts/test-container-entry.sh rejects with admin-prohibited, which connect() reports as this.
const FILTERED = "EHOSTUNREACH";

interface Target {
  host: string;
  port: number;
}

/** Resolves with the socket's error code, `timeout`, or `connected` when a route out exists. */
function tcpOutcome(target: Target): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(target);
    const finish = (outcome: string) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
}

/** An on-link datagram is queued for ARP and reported sent unless the container's filter refuses it. */
function udpSendOutcome(target: Target): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.send("recnrun", target.port, target.host, (error) => {
      socket.close();
      resolve(error ? ((error as NodeJS.ErrnoException).code ?? error.message) : "sent");
    });
  });
}

/** Chromium's WebRTC binds its host candidate to the address a UDP connect picks; nothing is sent. */
function udpRouteSource(target: Target): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.connect(target.port, target.host, (error?: Error) => {
      const outcome = error ? `rejected: ${error.message}` : socket.address().address;
      socket.close();
      resolve(outcome);
    });
  });
}

const MDNS = { host: "224.0.0.251", port: 5353 };

/** Frames eth0's egress filter dropped (scripts/test-container-entry.sh). */
function eth0Dropped(): number {
  const stats = execFileSync("tc", ["-s", "filter", "show", "dev", "eth0", "egress"], {
    encoding: "utf8",
  });
  return Number(/\(dropped (\d+),/.exec(stats)?.[1] ?? Number.NaN);
}

/** Sends an mDNS datagram out of eth0 with multicast loop on, and resolves once the loop copy arrives. */
function mdnsLoop(own: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const timer = setTimeout(() => finish("no loop copy"), CONNECT_TIMEOUT_MS);
    const finish = (outcome: string) => {
      clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };
    socket.on("message", (message) => {
      if (String(message) === "recnrun-mdns") finish("looped back");
    });
    socket.bind(MDNS.port, () => {
      socket.addMembership(MDNS.host, own);
      socket.setMulticastInterface(own);
      socket.setMulticastLoopback(true);
      socket.send("recnrun-mdns", MDNS.port, MDNS.host, (error) => {
        if (error) finish((error as NodeJS.ErrnoException).code ?? error.message);
      });
    });
  });
}

const toNumber = (address: string) =>
  address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
const toAddress = (value: number) =>
  [16_777_216, 65_536, 256, 1].map((unit) => Math.floor(value / unit) % 256).join(".");

interface Subnet {
  own: string;
  gateway: string;
  peer: string;
}

/** The internal bridge's default route has no `via`, so its gateway is the subnet's first host (Docker IPAM). */
function eth0Subnet(): Subnet {
  const address = execFileSync("ip", ["-o", "-4", "addr", "show", "dev", "eth0"], {
    encoding: "utf8",
  });
  const match = /inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(address);
  if (!match?.[1] || !match[2]) throw new Error(`eth0 has no IPv4 address: ${address}`);
  const own = match[1];
  const size = 2 ** (32 - Number(match[2]));
  const route = execFileSync("ip", ["route", "show", "default"], { encoding: "utf8" });
  const gateway =
    /\bvia (\S+)/.exec(route)?.[1] ?? toAddress(Math.floor(toNumber(own) / size) * size + 1);
  const next = toNumber(gateway) + 1;
  const peer = toAddress(toAddress(next) === own ? next + 1 : next);
  return { own, gateway, peer };
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
    const outcome = await tcpOutcome(PUBLIC_ADDRESS);
    console.log(`TCP connect to ${PUBLIC_ADDRESS.host}:${PUBLIC_ADDRESS.port}: ${outcome}`);
    expect(outcome).not.toBe("connected");
  });

  // Docker's --internal still lets a container reach the bridge gateway's host services.
  for (const port of [80, 443]) {
    test(`the container's filter rejects a TCP connection to the gateway on port ${port}`, async () => {
      const { gateway } = eth0Subnet();
      const outcome = await tcpOutcome({ host: gateway, port });
      console.log(`TCP connect to the gateway ${gateway}:${port}: ${outcome}`);
      expect(outcome).toBe(FILTERED);
    });
  }

  // Docker's --internal still lets containers on the bridge reach each other.
  test("the container's filter rejects traffic to a peer address on its subnet", async () => {
    const peer = { host: eth0Subnet().peer, port: 80 };
    const connected = await tcpOutcome(peer);
    const sent = await udpSendOutcome(peer);
    console.log(`Peer ${peer.host}:${peer.port}: TCP connect ${connected}, UDP send ${sent}`);
    expect(connected).toBe(FILTERED);
    expect(sent).toBe("EPERM");
  });

  test("an mDNS datagram loops back to the container and eth0 drops the copy for the bridge", async () => {
    const { own } = eth0Subnet();
    const before = eth0Dropped();
    const outcome = await mdnsLoop(own);
    const dropped = eth0Dropped() - before;
    console.log(`mDNS to ${MDNS.host}:${MDNS.port}: ${outcome}, eth0 dropped ${dropped} frames`);
    expect(outcome).toBe("looped back");
    expect(dropped).toBeGreaterThan(0);
  });

  test("the eth0 address answers through lo and still sources the WebRTC route", async () => {
    const { own } = eth0Subnet();
    const server = createServer((_request, response) => response.end());
    await new Promise<void>((resolve) => server.listen(0, own, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await tcpOutcome({ host: own, port })).toBe("connected");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await udpRouteSource(PUBLIC_ADDRESS)).toBe(own);
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
