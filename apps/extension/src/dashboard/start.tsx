import { controlFrom } from "@/dashboard/control";
import { Dashboard } from "@/dashboard/Dashboard";
import { createFrameRouter } from "@/dashboard/router";
import type { ExtensionServices } from "@/views/extension-services";
import { renderFramed } from "@/views/framed";

export function startDashboard(
  root: HTMLElement,
  services: ExtensionServices,
  page: Window = window,
): void {
  // The site is the only way in: it frames the dashboard and opens the session's PiP window.
  renderFramed(root, page, import.meta.env.MODE, (parent) => {
    services.holdSitePorts();
    return (
      <Dashboard
        services={services}
        router={createFrameRouter(parent, page)}
        take={controlFrom(page, parent, services.send)}
      />
    );
  });
}
