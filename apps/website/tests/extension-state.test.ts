import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import { loadExtensionState } from "@/features/extension-status/extension-state";
import { installedGateway, missingGateway } from "./fake-gateway.ts";

test("a missing extension needs installing", async () => {
  await expect(loadExtensionState(missingGateway)).resolves.toEqual({ status: "missing" });
});

test("an installed extension provides its snapshot", async () => {
  await expect(loadExtensionState(installedGateway(sampleSnapshot()))).resolves.toEqual({
    status: "ready",
    extensionVersion: "0.1.0",
    snapshot: sampleSnapshot(),
  });
});

test("a failed snapshot request keeps the reason", async () => {
  await expect(loadExtensionState(installedGateway(new Error("Quota exceeded")))).resolves.toEqual({
    status: "failed",
    message: "Quota exceeded",
  });
});
