import { render } from "preact";
import { disallowedAncestor } from "@/config/origins";
import { closePanelMessage } from "@/messaging/frame-protocol";
import { documentPip } from "@/pip/document-pip";
import { FloatingSession, SessionPane } from "@/session/SessionPane";
import type { SessionTab } from "@/session/session-tab";
import type { RecordingStore } from "@/views/recording";
import { Refusal } from "@/views/Refusal";

/** What the session page reads and does, injected so tests need no extension APIs. */
export interface SessionData {
  recordings: RecordingStore;
  tab: SessionTab;
}

export function startSession(root: HTMLElement, data: SessionData, page: Window = window): void {
  // A dashboard tab's PiP window is a blank document of the extension's own origin.
  const ancestors = [...page.location.ancestorOrigins];
  const foreign = ancestors.filter((origin) => origin !== page.location.origin);
  const blocked = disallowedAncestor(foreign, import.meta.env.MODE);
  if (blocked !== undefined) {
    render(<Refusal origin={blocked} />, root);
    return;
  }
  const [parent] = ancestors;
  if (parent !== undefined) {
    const onEnd = () => page.parent.postMessage(closePanelMessage(), parent);
    render(<FloatingSession store={data.recordings} onEnd={onEnd} />, root);
    return;
  }
  render(<SessionPane store={data.recordings} tab={data.tab} pip={documentPip(page)} />, root);
}
