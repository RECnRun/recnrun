import type { ExtensionGateway } from "@/services/extension";

export const installedGateway: ExtensionGateway = {
  detect: async () => ({ status: "installed", extensionVersion: "0.1.0" }),
};

export const missingGateway: ExtensionGateway = {
  detect: async () => ({ status: "missing" }),
};
