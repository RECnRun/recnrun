import { useEffect, useState } from "preact/hooks";
import type { ExtensionDetection, ExtensionGateway } from "@/services/extension";

export type ExtensionState = { status: "detecting" } | ExtensionDetection;

export function useExtensionState(gateway: ExtensionGateway): ExtensionState {
  const [state, setState] = useState<ExtensionState>({ status: "detecting" });
  useEffect(() => {
    let active = true;
    void gateway.detect().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [gateway]);
  return state;
}
