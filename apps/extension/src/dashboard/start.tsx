import { render } from "preact";
import * as v from "valibot";
import { controlInTab, holdInTab } from "@/dashboard/control";
import type { FloatSession, RemoteTake } from "@/dashboard/control";
import { Dashboard } from "@/dashboard/Dashboard";
import { createHashRouter } from "@/dashboard/hash-router";
import { copyStyles } from "@/pip/document-pip";
import type { ExtensionServices } from "@/views/extension-services";
import { FloatingSession } from "@/views/FloatingSession";
import { eitherSession } from "@/views/remote-peer";

/** The session the PiP window floats: this profile's own, or the one it controls in a peer. */
function floated({ recordings, tabs, peers }: ExtensionServices) {
  const local = { recordings, tabs };
  return peers
    ? eitherSession(local, { recordings: peers.recordings, tabs: peers.sessionTabs })
    : local;
}

/** Renders the session into the dashboard tab's PiP window, of the extension's own origin. */
function floatSession(page: Window, services: ExtensionServices): FloatSession {
  return (pipWindow) => {
    const { body } = pipWindow.document;
    const { recordings, tabs } = floated(services);
    copyStyles(page.document, pipWindow.document);
    // Unmounting stops the session's watchers along with the window.
    pipWindow.addEventListener("pagehide", () => render(null, body));
    render(
      <FloatingSession store={recordings} tabs={tabs} onEnd={() => pipWindow.close()} />,
      body,
    );
  };
}

/** The PiP window and the control lock serve a session in a peer as one here. */
function remoteControl(page: Window, services: ExtensionServices): RemoteTake | undefined {
  const { peers } = services;
  if (!peers) return undefined;
  const hold = holdInTab(page, services.send, floatSession(page, services));
  return (peer) => (tabId) =>
    hold(() =>
      peers.client.ask({ type: "session-start", peer, tabId }, v.unknown()).then(() => {}),
    );
}

export function startDashboard(
  root: HTMLElement,
  services: ExtensionServices,
  page: Window = window,
): void {
  const take = controlInTab(page, services.send, floatSession(page, services));
  render(
    <Dashboard
      services={services}
      router={createHashRouter(page)}
      take={take}
      takeRemote={remoteControl(page, services)}
    />,
    root,
  );
}
