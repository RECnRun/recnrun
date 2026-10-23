import { createBridgeClient, createWindowTransport } from "@recnrun/bridge";
import type { Detection } from "@recnrun/bridge";

export type ExtensionDetection = Detection;

/** The website's only door to the extension. */
export interface ExtensionGateway {
  detect(): Promise<ExtensionDetection>;
}

export function createExtensionGateway(options: { timeoutMs?: number } = {}): ExtensionGateway {
  const client = createBridgeClient(createWindowTransport(), options);
  return { detect: () => client.detect() };
}
