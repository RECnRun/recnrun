import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { GET_SELF, LOADED_KEY, startBackground } from "@/background/start";

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

function expectNoExternalReach(manifest: Record<string, unknown>, source: string): void {
  expect(manifest, source).not.toHaveProperty("update_url");
  expect(manifest, source).not.toHaveProperty("externally_connectable");
  const permissions = [manifest.permissions, manifest.optional_permissions].flat();
  expect(permissions, source).not.toContain("nativeMessaging");
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
