import type { Snapshot } from "@recnrun/domain";
import type { ExtensionGateway } from "@/services/extension";

export function installedGateway(snapshot: Snapshot | Error): ExtensionGateway {
  return {
    detect: async () => ({ status: "installed", extensionVersion: "0.1.0" }),
    loadSnapshot: async () => {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
}

export const missingGateway: ExtensionGateway = {
  detect: async () => ({ status: "missing" }),
  loadSnapshot: () => Promise.reject(new Error("The extension is not installed.")),
};
