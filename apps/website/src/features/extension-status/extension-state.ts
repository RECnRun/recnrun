import { useEffect, useState } from "preact/hooks";
import type { ExtensionGateway } from "@/services/extension";

export type ExtensionState =
  | { status: "detecting" }
  | { status: "missing" }
  | { status: "ready"; extensionVersion: string };

export async function loadExtensionState(gateway: ExtensionGateway): Promise<ExtensionState> {
  const detection = await gateway.detect();
  if (detection.status === "missing") return { status: "missing" };
  return { status: "ready", extensionVersion: detection.extensionVersion };
}

export function useExtensionState(gateway: ExtensionGateway): ExtensionState {
  const [state, setState] = useState<ExtensionState>({ status: "detecting" });
  useEffect(() => {
    let active = true;
    void loadExtensionState(gateway).then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [gateway]);
  return state;
}
