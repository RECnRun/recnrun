import { describe, expect, test, vi } from "vite-plus/test";
import { createMessageListener, createRequestHandler } from "@/background/handler";

const handle = createRequestHandler({ extensionVersion: "0.1.0" });

describe("createRequestHandler", () => {
  test("answers ping with the extension version", async () => {
    await expect(handle("ping")).resolves.toEqual({ extensionVersion: "0.1.0" });
  });
});

describe("createMessageListener", () => {
  function listen(message: unknown, senderId = "own-id", handler = handle) {
    const sendResponse = vi.fn();
    const keepsChannelOpen = createMessageListener(handler, "own-id")(
      message,
      { id: senderId },
      sendResponse,
    );
    return { keepsChannelOpen, sendResponse };
  }

  test("replies asynchronously to this extension's own requests", async () => {
    const { keepsChannelOpen, sendResponse } = listen({ type: "ping" });
    expect(keepsChannelOpen).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        result: { extensionVersion: "0.1.0" },
      }),
    );
  });

  test("reports handler failures as error replies", async () => {
    const failing = () => Promise.reject(new Error("Quota exceeded"));
    const { sendResponse } = listen({ type: "ping" }, "own-id", failing);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Quota exceeded" }),
    );
  });

  test("ignores other senders and unknown messages", () => {
    for (const [message, sender] of [
      [{ type: "ping" }, "another-extension"],
      [{ type: "deleteEverything" }, "own-id"],
      ["ping", "own-id"],
    ] as const) {
      const { keepsChannelOpen, sendResponse } = listen(message, sender);
      expect(keepsChannelOpen).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });
});
