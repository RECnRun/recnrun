import { render } from "preact";
import { PairingPage } from "@/pairing/PairingPage";
import type { AskPeer } from "@/pairing/PairingPage";
import { Refusal } from "@/views/Refusal";

export interface PairingData {
  ask: AskPeer;
  watch: (onChange: () => void) => () => void;
}

/** A top-level extension tab only: no site may frame it, and it never starts a session. */
export function startPairing(root: HTMLElement, data: PairingData, page: Window = window): void {
  const [ancestor] = page.location.ancestorOrigins;
  if (ancestor !== undefined) {
    render(<Refusal origin={ancestor} />, root);
    return;
  }
  render(<PairingPage ask={data.ask} watch={data.watch} />, root);
}
