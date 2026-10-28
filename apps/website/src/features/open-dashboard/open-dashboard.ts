import { useEffect, useState } from "preact/hooks";
import type { ExtensionGateway } from "@/services/extension";

/** Brings the dashboard tab forward once as the page loads, and again on each `open`. */
export function useOpenDashboard(gateway: ExtensionGateway) {
  const [failed, setFailed] = useState(false);
  const open = () => {
    setFailed(false);
    void gateway.openDashboard().catch(() => setFailed(true));
  };
  // Once per page load: the gateway never changes while the page lives.
  useEffect(open, [gateway]);
  return { open, failed };
}
