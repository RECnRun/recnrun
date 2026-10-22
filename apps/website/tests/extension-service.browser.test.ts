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
