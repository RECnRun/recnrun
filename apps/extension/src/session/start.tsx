import { closePanelMessage } from "@/messaging/frame-protocol";
import { FloatingSession } from "@/session/FloatingSession";
import type { ExtensionServices } from "@/views/extension-services";
import { renderFramed } from "@/views/framed";

export function startSession(
  root: HTMLElement,
  services: Pick<ExtensionServices, "recordings" | "tabs">,
  page: Window = window,
): void {
  // The PiP window is a blank document of the site's origin, so the site is the only ancestor.
  renderFramed(root, page, import.meta.env.MODE, (parent) => {
    const onEnd = () => page.parent.postMessage(closePanelMessage(), parent);
    return <FloatingSession store={services.recordings} tabs={services.tabs} onEnd={onEnd} />;
  });
}
