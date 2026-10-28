import type { ExtensionGateway } from "@/services/extension";

const installedGateway: ExtensionGateway = {
  detect: async () => ({ status: "installed", extensionVersion: "0.1.0" }),
  openDashboard: async () => {},
};

export const missingGateway: ExtensionGateway = {
  detect: async () => ({ status: "missing" }),
  openDashboard: async () => {},
};

/** An installed extension that counts each request to open its dashboard, failing with `error`. */
export function dashboardGateway(error?: Error) {
  const opened: unknown[] = [];
  const gateway: ExtensionGateway = {
    ...installedGateway,
    openDashboard: async () => {
      opened.push(true);
      if (error) throw error;
    },
  };
  return { gateway, opened };
}
