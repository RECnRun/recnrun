import { closePanelMessage } from "@/messaging/frame-protocol";
import { FloatingSession } from "@/session/FloatingSession";
import type { TabSource } from "@/tabs/open-tabs";
import { renderFramed } from "@/views/framed";
import type { RecordingStore } from "@/views/recording";

/** What the session page reads, injected so tests need no extension APIs. */
export interface SessionData {
  recordings: RecordingStore;
  tabs?: TabSource;
}

export function startSession(root: HTMLElement, data: SessionData, page: Window = window): void {
  // The PiP window is a blank document of the site's origin, so the site is the only ancestor.
  renderFramed(root, page, import.meta.env.MODE, (parent) => {
    const onEnd = () => page.parent.postMessage(closePanelMessage(), parent);
    return <FloatingSession store={data.recordings} tabs={data.tabs} onEnd={onEnd} />;
  });
}
