import { expect, test } from "vite-plus/test";
import { createExtensionGateway } from "@/services/extension";

const announce = { channel: "recnrun", protocol: 1, kind: "announce", extensionVersion: "0.1.0" };

test("detects nothing when no extension answers", async () => {
  await expect(createExtensionGateway({ timeoutMs: 50 }).detect()).resolves.toEqual({
    status: "missing",
  });
});

test("detects an extension that announces itself on the page", async () => {
  const detection = createExtensionGateway({ timeoutMs: 500 }).detect();
  window.postMessage(announce, window.location.origin);
  await expect(detection).resolves.toEqual({ status: "installed", extensionVersion: "0.1.0" });
});

test("asks the extension to bring its dashboard forward, and settles once it answers", async () => {
  const answer = (event: MessageEvent) => {
    const data = event.data as { kind?: string; type?: string; id?: string };
    if (data.kind !== "request" || data.type !== "open-dashboard") return;
    const reply = { channel: "recnrun", protocol: 1, kind: "response", id: data.id, ok: true };
    window.postMessage({ ...reply, result: {} }, window.location.origin);
  };
  window.addEventListener("message", answer);
  await expect(createExtensionGateway({ timeoutMs: 500 }).openDashboard()).resolves.toBeUndefined();
  window.removeEventListener("message", answer);
});
