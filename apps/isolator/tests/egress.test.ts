import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { HARNESS_GLOBAL } from "@/background/probes/expose";
import type { ProbeHarness } from "@/background/probes/expose";
import type { ProbeTargets } from "@/background/probes/types";
import { ROUTE_A_GLOBAL } from "@/background/route-a/expose";
import type { RouteA } from "@/background/route-a/types";
import { GET_SELF, LOADED_KEY, startBackground } from "@/background/start";
import { STOP_GLOBAL } from "@/background/stop/expose";
import type { Stop } from "@/background/stop/types";
import { fakeDebugger, URLS } from "./fake-debugger";

/** R11 (POC PLAN.md §1): the runtime talks to nothing but the loopback and itself. */
function isLocal(target: string): boolean {
  const url = new URL(target);
  if (url.protocol === "chrome-extension:") return true;
  const host = url.hostname;
  return ["127.0.0.1", "localhost", "[::1]"].includes(host) || host.endsWith(".localhost");
}

const egress: string[] = [];

function guard(target: string | URL): void {
  const url = String(target);
  if (isLocal(url)) return;
  egress.push(url);
  throw new Error(`Egress to ${url}`);
}

function requestUrl(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

class GuardedWebSocket {
  constructor(url: string | URL) {
    guard(url);
  }
}

class GuardedEventSource {
  constructor(url: string | URL) {
    guard(url);
  }
}

class GuardedXMLHttpRequest {
  open(_method: string, url: string | URL): void {
    guard(url);
  }
}

const ISOLATOR = fileURLToPath(new URL("..", import.meta.url));
const BUILT_MANIFEST = `${ISOLATOR}.output/chrome-mv3-test/manifest.json`;

/** Starts the background with a fake chrome.debugger and returns the probe entrypoint it exposed. */
function probeEntrypoint() {
  const debuggerFake = fakeDebugger();
  Object.assign(fakeBrowser, { debugger: debuggerFake.api });
  startBackground();
  const harness = (globalThis as Record<string, unknown>)[HARNESS_GLOBAL] as ProbeHarness;
  return { harness, sent: debuggerFake.sent, emit: debuggerFake.emit };
}

function expectNoExternalReach(manifest: Record<string, unknown>, source: string): void {
  expect(manifest, source).not.toHaveProperty("update_url");
  expect(manifest, source).not.toHaveProperty("externally_connectable");
  const permissions = [manifest.permissions, manifest.optional_permissions].flat();
  expect(permissions, source).not.toContain("nativeMessaging");
  const hosts = [manifest.host_permissions, manifest.optional_host_permissions].flat();
  for (const host of hosts.filter((entry) => entry !== undefined)) {
    const pattern = typeof host === "string" ? host : JSON.stringify(host);
    expect(URL.canParse(pattern) && isLocal(pattern), `${source}: ${pattern}`).toBe(true);
  }
}

describe("isolator egress", () => {
  beforeEach(() => {
    egress.length = 0;
    fakeBrowser.reset();
    fakeBrowser.management.getSelf = vi.fn(async () => ({ id: fakeBrowser.runtime.id })) as never;
    fakeBrowser.runtime.getManifest = () => ({ manifest_version: 3, name: "x", version: "0.1.0" });
    vi.stubGlobal("fetch", async (input: unknown) => {
      guard(requestUrl(input));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("WebSocket", GuardedWebSocket);
    vi.stubGlobal("EventSource", GuardedEventSource);
    vi.stubGlobal("XMLHttpRequest", GuardedXMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("the shim refuses every host but the loopback and the extension itself", async () => {
    expect(() => guard("https://example.com/")).toThrow("Egress to https://example.com/");
    await expect(fetch("http://api.example.org/x")).rejects.toThrow("Egress");
    expect(() => new WebSocket("wss://example.com/ws")).toThrow("Egress");
    expect(() => new EventSource("https://example.com/events")).toThrow("Egress");
    expect(() => new XMLHttpRequest().open("GET", "https://example.com/")).toThrow("Egress");
    for (const local of [
      "http://127.0.0.1:4601/me",
      "http://localhost/",
      "http://app.localhost:4600/",
      "http://[::1]:9/",
      "chrome-extension://abcdefghijklmnop/page.html",
    ]) {
      expect(() => guard(local), local).not.toThrow();
    }
  });

  test("the background reaches no host outside the loopback on install, startup, or a message", async () => {
    startBackground();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: "install" });
    await fakeBrowser.runtime.onStartup.trigger();
    const sendResponse = vi.fn();
    const listeners = await fakeBrowser.runtime.onMessage.trigger(
      { type: GET_SELF },
      { id: fakeBrowser.runtime.id },
      sendResponse,
    );
    expect(listeners).toEqual([true]);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    await vi.waitFor(async () =>
      expect(await fakeBrowser.storage.session.get(LOADED_KEY)).toHaveProperty(LOADED_KEY),
    );
    expect(egress).toEqual([]);
  });

  test("the probe entrypoint reaches no host outside the loopback", async () => {
    const { harness, sent } = probeEntrypoint();
    // The entrypoint waits in real time between probes; fake timers keep the test fast.
    vi.useFakeTimers();
    const run = harness.run(URLS);
    await vi.runAllTimersAsync();
    const results = await run;
    expect(results.length).toBe(harness.ids.length);
    expect(sent.length).toBeGreaterThan(0);
    expect(egress).toEqual([]);
  });

  test.each<[keyof ProbeTargets, string]>([
    ["cookieUrl", "https://example.com/"],
    ["iframeUrl", "http://127.0.0.1.example.com/whoami"],
    ["pageUrl", "http://localhost.example.com/workers.html"],
    ["serviceWorkerUrl", "file:///etc/passwd"],
    ["sharedWorkerUrl", "not a url"],
    ["dedicatedWorkerUrl", "chrome-extension://abcdefghijklmnop/worker.js"],
  ])(
    "the probe entrypoint refuses a %s outside the loopback before any command",
    async (key, url) => {
      const { harness, sent } = probeEntrypoint();
      await expect(harness.run({ ...URLS, [key]: url })).rejects.toThrow(
        `probe targets outside the loopback: ${key}=${url}`,
      );
      expect(sent).toEqual([]);
      expect(egress).toEqual([]);
    },
  );

  test("Route A reaches no host outside the loopback", async () => {
    const { sent, emit } = probeEntrypoint();
    const routeA = (globalThis as Record<string, unknown>)[ROUTE_A_GLOBAL] as RouteA;
    routeA.setMarker("egress");
    await routeA.arm({ tabId: 7 });
    emit({ tabId: 7 }, "Target.attachedToTarget", {
      sessionId: "s-sw",
      waitingForDebugger: true,
      targetInfo: { targetId: "sw", type: "service_worker", url: URLS.serviceWorkerUrl },
    });
    await routeA.attachTarget({ targetId: "shared" });
    await routeA.disarm({ tabId: 7 });
    await routeA.clearOrigin({ tabId: 7 });
    expect(sent.map((entry) => entry.method)).toContain("Runtime.runIfWaitingForDebugger");
    expect(egress).toEqual([]);
  });

  test("the stop mechanisms reach no host outside the loopback", async () => {
    const { sent, emit } = probeEntrypoint();
    vi.spyOn(fakeBrowser.declarativeNetRequest, "updateSessionRules").mockResolvedValue();
    vi.spyOn(fakeBrowser.declarativeNetRequest, "getSessionRules").mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([] as never);
    const stop = (globalThis as Record<string, unknown>)[STOP_GLOBAL] as Stop;
    stop.watch({ marker: "egress" });
    await stop.terminateExecution({ targetId: "sw" });
    await stop.pauseHold({ targetId: "sw" });
    await stop.release({ targetId: "sw" });
    await stop.blockScope({ origin: "http://app.localhost:4600" });
    await stop.unblock();
    await stop.unregister({ tabId: 7 });
    await stop.client({ tabId: 7, action: "status" });
    await stop.closeTarget({ targetId: "sw" });
    emit({ tabId: 7, sessionId: "s-sw" }, "Inspector.targetReloadedAfterCrash");
    await stop.unwatch();
    expect(sent.map((entry) => entry.method)).toContain("Runtime.runIfWaitingForDebugger");
    expect(egress).toEqual([]);
  });

  test("the manifest's host permissions stay on the loopback, with the origins the stop mechanisms evict", async () => {
    const config = (await import(pathToFileURL(`${ISOLATOR}wxt.config.ts`).href)) as {
      default: { manifest: { permissions?: string[]; host_permissions?: string[] } };
    };
    expect(config.default.manifest.permissions).toContain("declarativeNetRequest");
    const hosts = config.default.manifest.host_permissions ?? [];
    expect(hosts).toEqual(
      expect.arrayContaining(["http://app.localhost:4600/*", "http://app.localhost:4603/*"]),
    );
    for (const host of hosts) expect(host).toMatch(/^http:\/\/(\*\.|app\.)localhost(:\d+)?\/\*$/);
  });

  test("the manifest asks for no update URL, external connection, or native messaging", async () => {
    const config = (await import(pathToFileURL(`${ISOLATOR}wxt.config.ts`).href)) as {
      default: { manifest?: unknown };
    };
    expect(typeof config.default.manifest, "wxt.config.ts manifest is an object").toBe("object");
    expectNoExternalReach(config.default.manifest as Record<string, unknown>, "wxt.config.ts");
    // The built manifest exists after `vp run @recnrun/isolator#build:test`; P7.1 guards the release build.
    if (existsSync(BUILT_MANIFEST)) {
      const built = JSON.parse(await readFile(BUILT_MANIFEST, "utf8")) as Record<string, unknown>;
      expectNoExternalReach(built, BUILT_MANIFEST);
    }
  });
});
