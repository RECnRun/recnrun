import { expect, test, vi } from "vite-plus/test";
import { createRequester } from "@/messaging/request";

test("sends the request envelope and returns the validated result", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, result: { extensionVersion: "0.1.0" } }));
  await expect(createRequester(sendMessage)("ping")).resolves.toEqual({
    extensionVersion: "0.1.0",
  });
  expect(sendMessage).toHaveBeenCalledWith({ kind: "request", type: "ping" });
});

test("includes the payload when there is one", async () => {
  const sendMessage = vi.fn(async () => ({ ok: true, result: [] }));
  await createRequester(sendMessage)("listSteps", { workflowId: "wf-login" });
  expect(sendMessage).toHaveBeenCalledWith({
    kind: "request",
    type: "listSteps",
    payload: { workflowId: "wf-login" },
  });
});

test("rethrows the background's error and rejects malformed replies and results", async () => {
  await expect(
    createRequester(async () => ({ ok: false, error: "Quota exceeded" }))("listWorkflows"),
  ).rejects.toThrow("Quota exceeded");
  await expect(createRequester(async () => undefined)("listWorkflows")).rejects.toThrow();
  await expect(
    createRequester(async () => ({ ok: true, result: { nope: 1 } }))("listWorkflows"),
  ).rejects.toThrow("invalid listWorkflows result");
});
