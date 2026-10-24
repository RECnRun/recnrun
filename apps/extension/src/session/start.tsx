import { render } from "preact";
import { disallowedAncestor } from "@/config/origins";
import { closePanelMessage } from "@/messaging/frame-protocol";
import { FloatingSession } from "@/session/FloatingSession";
import type { RecordingStore } from "@/views/recording";
import { Refusal, SiteOnly } from "@/views/Refusal";

/** What the session page reads, injected so tests need no extension APIs. */
export interface SessionData {
  recordings: RecordingStore;
}

export function startSession(root: HTMLElement, data: SessionData, page: Window = window): void {
  // The PiP window is a blank document of the site's origin, so the site is the only ancestor.
  const ancestors = [...page.location.ancestorOrigins];
  const blocked = disallowedAncestor(ancestors, import.meta.env.MODE);
  if (blocked !== undefined) {
    render(<Refusal origin={blocked} />, root);
    return;
  }
  const [parent] = ancestors;
  if (parent === undefined) {
    render(<SiteOnly />, root);
    return;
  }
  const onEnd = () => page.parent.postMessage(closePanelMessage(), parent);
  render(<FloatingSession store={data.recordings} onEnd={onEnd} />, root);
}
