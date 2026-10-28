import { createBridgeClient, createWindowTransport } from "@recnrun/bridge";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startContentBridge } from "@/content/start";

const VERSION = "0.1.0";

/** The extension APIs the content script reaches for, with a background that answers `ping`. */
const browser = vi.hoisted(() => ({
  runtime: {
    getManifest: () => ({ version: "0.1.0" }),
    sendMessage: vi.fn(async (message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message;
      return type && message.type === "ping"
        ? { ok: true, result: { extensionVersion: "0.1.0" } }
        : { ok: false, error: "Unknown message" };
    }),
  },
}));

vi.mock("wxt/browser", () => ({ browser }));

afterEach(() => {
  vi.clearAllMocks();
});

test("answers the site's requests through the background and adds nothing to the page", async () => {
  const before = document.body.innerHTML;
  startContentBridge();
  const client = createBridgeClient(createWindowTransport());
  await expect(client.request("ping")).resolves.toEqual({ extensionVersion: VERSION });
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ type: "ping" });
  expect(document.body.innerHTML).toBe(before);
});
