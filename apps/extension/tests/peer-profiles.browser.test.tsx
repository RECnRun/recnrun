import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { Dashboard } from "@/dashboard/Dashboard";
import { startDashboard } from "@/dashboard/start";
import { openPanelMessage } from "@/messaging/frame-protocol";
import type { PeerStatus } from "@/messaging/peer-results";
import { returnToDashboardMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import type { OpenTab } from "@/ports/tabs";
import type { PeerServices } from "@/views/remote-peer";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";
import { fakeExtension, memoryRecordingStore } from "./fake-extension";
import { closedFor, fakePeerClient, statusOf, withPeerSession } from "./fake-peer-client";
import { SHOP, fakeTabs } from "./fake-tabs";
import {
  alertText,
  buttons,
  closePanel,
  expectControlFree,
  framedPage,
  item,
} from "./framed-dashboard";
import { button } from "./queries";

const MAIL: OpenTab = { ...SHOP, id: 21, title: "Mail", url: "https://mail.example/" };

function peerServices(peer: ReturnType<typeof fakePeerClient>) {
  const opened: unknown[] = [];
  const peers: PeerServices = {
    client: peer.client,
    tabs: fakeTabs({ tabs: [MAIL] }).source,
    recordings: memoryRecordingStore(),
    openPairing: async () => {
      opened.push(true);
    },
  };
  return { peers, opened };
}

/** A framed dashboard in Alice's profile, with Bob's profile as `peer` answers for it. */
function mount(peer: ReturnType<typeof fakePeerClient>) {
  const { peers, opened } = peerServices(peer);
  const sent: SessionRequest[] = [];
  const send = async (request: SessionRequest) => {
    sent.push(request);
    return { ok: true };
  };
  const page = framedPage();
  const root = document.body.appendChild(document.createElement("div"));
  startDashboard(
    root,
    fakeExtension({ tabs: fakeTabs({ tabs: [SHOP] }).source, send, peers }),
    page,
  );
  return { root, sent, page, opened };
}

const headings = (root: HTMLElement) =>
  [...root.querySelectorAll("aside h2")].map((each) => each.textContent);
const remote = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('aside[aria-labelledby="remote-tabs-heading"]') ?? undefined;

const note = (scope: HTMLElement | undefined) => scope?.querySelector(".tab-note")?.textContent;

const posted: unknown[] = [];
const onMessage = (event: MessageEvent) => posted.push(event.data);

afterEach(() => {
  window.removeEventListener("message", onMessage);
  posted.length = 0;
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("an unpaired profile shows the local dashboard and offers to pair", async () => {
  const { root, opened } = mount(fakePeerClient(statusOf()));
  await expect.poll(() => button(root, "Pair another profile")).toBeDefined();
  // Local use with no peer looks as it does without the POC.
  expect(headings(root)).toEqual(["Tabs"]);
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
  button(root, "Pair another profile")?.click();
  await expect.poll(() => opened).toHaveLength(1);
});

test("before the background answers, the dashboard is the local one", async () => {
  const { root } = mount(fakePeerClient(statusOf(), { status: () => new Promise(() => {}) }));
  await expect.poll(() => headings(root)).toEqual(["Tabs"]);
  expect(button(root, "Pair another profile")).toBeDefined();
});

test("the paired profile's tabs follow under its name and the link's state", async () => {
  const peer = fakePeerClient(statusOf("idle"));
  const { root } = mount(peer);
  const states: [PeerStatus, string][] = [
    [statusOf("idle"), "Disconnected"],
    [statusOf("connecting"), "Connecting"],
    [statusOf("connected", false), "Connecting"],
    [statusOf("connected"), "Connected"],
    [statusOf("disconnected"), "Disconnected"],
    [closedFor("disconnected", "closed-here"), "Disconnected"],
    [closedFor("disconnected", "closed-by-peer"), "Disconnected by Bob"],
    [closedFor("failed", "closed-by-peer"), "Disconnected by Bob"],
    [statusOf("failed"), "Not reachable"],
    [closedFor("failed", "certificate"), "Error"],
  ];
  for (const [status, state] of states) {
    peer.change(status);
    await expect
      .poll(() => headings(root))
      .toEqual(["Chrome — Alice (Local)", `Chrome — Bob (${state})`]);
  }
  peer.change(statusOf("connected"));
  await expect
    .poll(() => buttons(item(remote(root) ?? root, "Mail")))
    .toEqual(["Record", "Show tab"]);
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
  expect(button(root, "Manage pairing")).toBeDefined();
});

test("while the link is down, the other profile's tabs are read only, as last seen", async () => {
  const peer = fakePeerClient(statusOf("connected"));
  const { root } = mount(peer);
  await expect
    .poll(() => buttons(item(remote(root) ?? root, "Mail")))
    .toEqual(["Record", "Show tab"]);
  expect(note(remote(root))).toBeUndefined();

  peer.change(statusOf("disconnected"));
  await expect.poll(() => buttons(item(remote(root) ?? root, "Mail"))).toEqual([]);
  expect(note(remote(root))).toBe("Not connected. These tabs are as last seen.");
  const recording = { status: "recording" as const, mine: true, live: false };
  peer.change(withPeerSession(statusOf("disconnected"), recording));
  await expect.poll(() => note(remote(root))).toBe("Not connected. Last seen recording.");
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
});

test("Show tab brings the other profile's tab to the front, or shows why it cannot", async () => {
  let refuse = false;
  const peer = fakePeerClient(statusOf("connected"), {
    activate: () => {
      if (refuse) throw new Error("The other profile is not connected.");
      return {};
    },
  });
  const { root } = mount(peer);
  await expect.poll(() => button(remote(root) ?? root, "Show tab")).toBeDefined();
  button(remote(root) ?? root, "Show tab")?.click();
  await expect.poll(() => peer.asked("activate")).toEqual([{ type: "activate", tabId: MAIL.id }]);

  refuse = true;
  button(remote(root) ?? root, "Show tab")?.click();
  await expect
    .poll(() => alertText(remote(root) ?? root))
    .toBe("The other profile is not connected.");
});

test("Record on the other profile's tab takes the control and starts the session there", async () => {
  window.addEventListener("message", onMessage);
  const peer = fakePeerClient(statusOf("connected"));
  const { root, sent, page } = mount(peer);
  await expect.poll(() => button(remote(root) ?? root, "Record")).toBeDefined();
  button(remote(root) ?? root, "Record")?.click();

  await expect
    .poll(() => peer.asked("session-start"))
    .toEqual([{ type: "session-start", tabId: MAIL.id }]);
  await expect.poll(() => posted).toContainEqual(openPanelMessage());
  expect(await tryHoldLock(CONTROL_LOCK)).toBeUndefined();
  expect(sent).toEqual([]);

  closePanel(page);
  await expect.poll(() => sent).toEqual([returnToDashboardMessage()]);
  await expectControlFree();
});

test("a session the other profile cannot start frees the control and shows the error", async () => {
  const peer = fakePeerClient(statusOf("connected"), {
    "session-start": () => {
      throw new Error("The other profile is not connected.");
    },
  });
  const { root } = mount(peer);
  await expect.poll(() => button(remote(root) ?? root, "Record")).toBeDefined();
  button(remote(root) ?? root, "Record")?.click();
  await expect
    .poll(() => alertText(remote(root) ?? root))
    .toBe("The other profile is not connected.");
  await expectControlFree();
});

test("without a way to control the other profile, the dashboard lists only its own tabs", async () => {
  const { peers } = peerServices(fakePeerClient(statusOf("connected")));
  const router = {
    initialRoute: "/",
    href: (path: string) => `#${path}`,
    subscribe: () => () => {},
    navigate: () => {},
    publish: () => {},
  };
  const root = document.body.appendChild(document.createElement("div"));
  render(
    <Dashboard services={fakeExtension({ peers })} router={router} take={async () => {}} />,
    root,
  );
  await expect.poll(() => headings(root)).toEqual(["Tabs"]);
  expect(button(root, "Manage pairing")).toBeUndefined();
});
