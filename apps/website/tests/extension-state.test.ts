import { expect, test } from "vite-plus/test";
import { loadExtensionState } from "@/features/extension-status/extension-state";
import { installedGateway, missingGateway } from "./fake-gateway.ts";

test("a missing extension needs installing", async () => {
  await expect(loadExtensionState(missingGateway)).resolves.toEqual({ status: "missing" });
});

test("an installed extension reports its version", async () => {
  await expect(loadExtensionState(installedGateway())).resolves.toEqual({
    status: "ready",
    extensionVersion: "0.1.0",
  });
});
