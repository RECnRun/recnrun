import { startDashboard } from "@/dashboard/start";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { OpenTab } from "@/ports/tabs";
import type { PeerServices } from "@/views/remote-peer";
import { fakeExtension, memoryRecordingStore } from "./fake-extension";
import { CAROL_ID, type fakePeerClient } from "./fake-peer-client";
import { SHOP, fakeTabs } from "./fake-tabs";
import { pipWindow, tabPage } from "./dashboard-page";

export const MAIL: OpenTab = { ...SHOP, id: 21, title: "Mail", url: "https://mail.example/" };
/** Carol's tab; Bob has `MAIL`. */
export const NOTES: OpenTab = { ...SHOP, id: 31, title: "Notes", url: "https://notes.example/" };

export const pairingSection = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="pairing-heading"]');

/** The paired profiles as `peer` answers for them, each with one tab. */
export function peerServices(peer: ReturnType<typeof fakePeerClient>) {
  const folders: unknown[] = [];
  const peers: PeerServices = {
    client: peer.client,
    tabsOf: (id) => fakeTabs({ tabs: [id === CAROL_ID ? NOTES : MAIL] }).source,
    recordingsOf: () => memoryRecordingStore(),
    recordings: memoryRecordingStore(),
    sessionTabs: fakeTabs({ tabs: [] }).source,
    chooseFolder: async () => {
      folders.push("choose");
    },
    allowFolder: async () => {
      folders.push("allow");
    },
  };
  return { peers, folders };
}

/** A dashboard tab in Alice's profile, with the profiles `peer` answers for. */
export function mount(
  peer: ReturnType<typeof fakePeerClient>,
  recordings = memoryRecordingStore(),
) {
  const { peers, folders } = peerServices(peer);
  const sent: SessionRequest[] = [];
  const send = async (request: SessionRequest) => {
    sent.push(request);
    return { ok: true };
  };
  const pips: Window[] = [];
  const page = tabPage("", async () => {
    pips.push(pipWindow());
    return pips.at(-1) as Window;
  });
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(
    root,
    fakeExtension({ tabs: fakeTabs({ tabs: [SHOP] }).source, send, peers, recordings }),
    page,
  );
  return { root, sent, pips, folders };
}

export const headings = (root: HTMLElement) =>
  [...root.querySelectorAll("aside h2")].map((each) => each.textContent);

/** The list of the paired profile named `name`, or the first one's. */
export const remote = (root: HTMLElement, name = "") =>
  [...root.querySelectorAll<HTMLElement>('aside[aria-labelledby^="remote-tabs-"]')].find((each) =>
    each.querySelector("h2")?.textContent.includes(`— ${name}`),
  );

/** The pairing section's line about the profile named `name`. */
export const lineOf = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLElement>(".pairing-section li")].find((each) =>
    each.querySelector('[role="status"]')?.textContent.includes(name),
  );

export const note = (scope: HTMLElement | undefined) =>
  scope?.querySelector(".tab-note")?.textContent;

export const notes = (root: HTMLElement) =>
  [...root.querySelectorAll(".tab-note")].map((each) => each.textContent);

export const banner = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="folder-banner-heading"]')?.textContent ?? undefined;
