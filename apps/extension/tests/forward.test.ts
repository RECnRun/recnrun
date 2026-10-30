import { expect, test, vi } from "vite-plus/test";
import { createForwardingHandler } from "@/content/forward";

test("forwards the request envelope without a payload and unwraps a successful reply", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, result: { extensionVersion: "0.1.0" } }));
  await expect(createForwardingHandler(sendMessage)("ping", undefined)).resolves.toEqual({
    extensionVersion: "0.1.0",
  });
  expect(sendMessage).toHaveBeenCalledWith({ kind: "request", type: "ping" });
});

test("forwards the payload with the request", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, result: [] }));
  await createForwardingHandler(sendMessage)("listSteps", { workflowId: "wf-login" });
  expect(sendMessage).toHaveBeenCalledWith({
    kind: "request",
    type: "listSteps",
    payload: { workflowId: "wf-login" },
  });
});

test("rethrows the background's error", async () => {
  const handler = createForwardingHandler(async () => ({ ok: false, error: "Quota exceeded" }));
  await expect(handler("listWorkflows", undefined)).rejects.toThrow("Quota exceeded");
});

test("rejects a malformed reply", async () => {
  const handler = createForwardingHandler(async () => undefined);
  await expect(handler("listWorkflows", undefined)).rejects.toThrow();
});
