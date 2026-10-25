import { createBridgeClient, createWindowTransport } from "@recnrun/bridge";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { INCOGNITO_NOTICE } from "@/content/notice";
import { startContentBridge } from "@/content/start";
import { SITE_PORT } from "@/messaging/site-port";

const EXTENSION = "chrome-extension://test-id";
const VERSION = "0.1.0";

/** The extension APIs the content script reaches for, with a background that answers `ping`. */
const browser = vi.hoisted(() => ({
  runtime: {
    getManifest: () => ({ version: "0.1.0" }),
    getURL: (path: string) => `chrome-extension://test-id${path}`,
    sendMessage: vi.fn(async (message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message;
      return type && message.type === "ping"
        ? { ok: true, result: { extensionVersion: "0.1.0" } }
        : { ok: false, error: "Unknown message" };
    }),
    connect: vi.fn(() => ({ name: "recnrun-site", onDisconnect: { addListener: () => {} } })),
  },
  extension: { inIncognitoContext: false },
}));

vi.mock("wxt/browser", () => ({ browser }));

const currentPath = () => location.pathname + location.search + location.hash;

afterEach(() => {
  browser.extension.inIncognitoContext = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
  document.documentElement.style.overflow = "";
});

test("answers the site's requests through the background and covers it with the dashboard", async () => {
  startContentBridge();
  const client = createBridgeClient(createWindowTransport());
  await expect(client.request("ping")).resolves.toEqual({ extensionVersion: VERSION });
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: "ping" });

  const frame = document.querySelector("iframe");
  expect(frame?.title).toBe("RECnRun dashboard");
  expect(frame?.getAttribute("src")).toBe(
    `${EXTENSION}/dashboard.html?route=${encodeURIComponent(currentPath())}`,
  );
  expect(document.querySelector('[role="status"]')).toBeNull();

  frame?.dispatchEvent(new Event("load"));
  expect(browser.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: SITE_PORT });
});

test("in an incognito tab, answers the site but shows a notice instead of the dashboard", async () => {
  browser.extension.inIncognitoContext = true;
  startContentBridge();
  expect(document.querySelector("iframe")).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(INCOGNITO_NOTICE);

  const client = createBridgeClient(createWindowTransport());
  await expect(client.detect()).resolves.toEqual({
    status: "installed",
    extensionVersion: VERSION,
  });
  expect(browser.runtime.connect).not.toHaveBeenCalled();
});
