import { render } from "preact";
import { controlInTab } from "@/dashboard/control";
import type { FloatSession } from "@/dashboard/control";
import { Dashboard } from "@/dashboard/Dashboard";
import { createHashRouter } from "@/dashboard/hash-router";
import { copyStyles } from "@/pip/document-pip";
import type { ExtensionServices } from "@/views/extension-services";
import { FloatingSession } from "@/views/FloatingSession";

/** Renders the session into the dashboard tab's PiP window, of the extension's own origin. */
function floatSession(page: Window, services: ExtensionServices): FloatSession {
  return (pipWindow) => {
    const { body } = pipWindow.document;
    copyStyles(page.document, pipWindow.document);
    // Unmounting stops the session's watchers along with the window.
    pipWindow.addEventListener("pagehide", () => render(null, body));
    render(
      <FloatingSession
        store={services.recordings}
        tabs={services.tabs}
        onEnd={() => pipWindow.close()}
      />,
      body,
    );
  };
}

export function startDashboard(
  root: HTMLElement,
  services: ExtensionServices,
  page: Window = window,
): void {
  const take = controlInTab(page, services.send, floatSession(page, services));
  render(<Dashboard services={services} router={createHashRouter(page)} take={take} />, root);
}
