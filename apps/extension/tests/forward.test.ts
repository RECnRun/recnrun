import { expect, test, vi } from "vite-plus/test";
import { createForwardingHandler } from "@/content/forward";

test("forwards the request type and unwraps a successful reply", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, result: { extensionVersion: "0.1.0" } }));
  await expect(createForwardingHandler(sendMessage)("ping")).resolves.toEqual({
    extensionVersion: "0.1.0",
  });
  expect(sendMessage).toHaveBeenCalledWith({ type: "ping" });
});

test("rethrows the background's error", async () => {
  const handler = createForwardingHandler(async () => ({ ok: false, error: "Quota exceeded" }));
  await expect(handler("getSnapshot")).rejects.toThrow("Quota exceeded");
});

test("rejects a malformed reply", async () => {
  const handler = createForwardingHandler(async () => undefined);
  await expect(handler("getSnapshot")).rejects.toThrow();
});
