import { render } from "preact";
import { expect, test } from "vite-plus/test";
import { useExtensionState } from "@/features/extension-status/extension-state";
import type { ExtensionDetection, ExtensionGateway } from "@/services/extension";
import { missingGateway } from "./fake-gateway.ts";

function Status({ gateway }: { gateway: ExtensionGateway }) {
  return <output>{useExtensionState(gateway).status}</output>;
}

function deferredGateway() {
  let settle: (detection: ExtensionDetection) => void = () => {};
  const gateway: ExtensionGateway = {
    detect: () => new Promise((resolve) => (settle = resolve)),
  };
  return { gateway, settle: (detection: ExtensionDetection) => settle(detection) };
}

test("ignores a detection that settles after its effect was torn down", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const slow = deferredGateway();
  render(<Status gateway={slow.gateway} />, root);
  expect(root.textContent).toBe("detecting");

  // Replacing the gateway runs the first effect's cleanup, as unmounting does.
  render(<Status gateway={missingGateway} />, root);
  await expect.poll(() => root.textContent).toBe("missing");

  slow.settle({ status: "installed", extensionVersion: "0.1.0" });
  await new Promise((done) => setTimeout(done, 20));
  expect(root.textContent).toBe("missing");
});
