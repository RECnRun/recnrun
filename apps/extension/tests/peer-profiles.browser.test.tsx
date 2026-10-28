import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { Dashboard } from "@/dashboard/Dashboard";
import type { PeerStatus } from "@/messaging/peer-results";
import { returnToDashboardMessage } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";
import { fakeExtension, memoryRecordingStore } from "./fake-extension";
import {
  BOB_ID,
  closedFor,
  controlledByBob,
  fakePeerClient,
  statusOf,
  withPeerSession,
} from "./fake-peer-client";
import { SHOP } from "./fake-tabs";
import { alertText, buttons, expectControlFree, item } from "./dashboard-page";
import {
  MAIL,
  banner,
  headings,
  mount,
  note,
  notes,
  pairingSection,
  peerServices,
  remote,
} from "./peer-dashboard";
import { button } from "./queries";

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("an unpaired profile shows the local dashboard and offers to pair", async () => {
  const peer = fakePeerClient(statusOf());
  const { root } = mount(peer);
  await expect.poll(() => button(root, "Pair with another profile")).toBeDefined();
  // Local use with no peer looks as it does without the POC.
  expect(headings(root)).toEqual(["Tabs"]);
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
  button(root, "Pair with another profile")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
});

test("before the background answers, the dashboard is the local one", async () => {
  const { root } = mount(fakePeerClient(statusOf(), { status: () => new Promise(() => {}) }));
  await expect.poll(() => headings(root)).toEqual(["Tabs"]);
  expect(pairingSection(root)).not.toBeNull();
  expect(button(root, "Pair with another profile")).toBeUndefined();
  expect(banner(root)).toBeUndefined();
});

test("until Chrome grants the RECnRun folder, a banner shows Chrome's picker in the dashboard", async () => {
  const { root, folders } = mount(fakePeerClient({ ...statusOf(), folder: "none" }));
  await expect.poll(() => banner(root)).toContain("Choose the RECnRun folder");
  // Recording needs no folder.
  expect(buttons(item(root, "Shop"))).toEqual(["Record"]);
  button(root, "Choose folder")?.click();
  await expect.poll(() => folders).toEqual(["choose"]);
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
  expect(pairingSection(root)).not.toBeNull();
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

test("one session across the pair: each list says why it offers no Record", async () => {
  const local = memoryRecordingStore();
  const peer = fakePeerClient(statusOf("connected"));
  const { root } = mount(peer, local);
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual(["Record"]);

  peer.change(
    withPeerSession(statusOf("connected"), { status: "recording", mine: false, live: true }),
  );
  await expect.poll(() => buttons(item(root, "Shop"))).toEqual([]);
  expect(buttons(item(remote(root) ?? root, "Mail"))).toEqual(["Show tab"]);
  expect(notes(root)).toEqual(["Recording in Bob", "Recording in Bob"]);

  // Bob controls the session that runs here: no Continue or Stop, only its state.
  await local.write({ tabId: SHOP.id, status: "recording", banked: 0, since: Date.now() });
  peer.change(controlledByBob(statusOf("connected")));
  await expect
    .poll(() => note(root.querySelector("aside") ?? undefined))
    .toBe("Controlled from Bob");
  expect(buttons(item(root, "Shop"))).toEqual([]);
  expect(item(root, "Shop")?.textContent).toContain("Recording");
  expect(note(remote(root))).toBe("Recording in Alice");
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
  await expect
    .poll(() => peer.asked("activate"))
    .toEqual([{ type: "activate", peer: BOB_ID, tabId: MAIL.id }]);

  refuse = true;
  button(remote(root) ?? root, "Show tab")?.click();
  await expect
    .poll(() => alertText(remote(root) ?? root))
    .toBe("The other profile is not connected.");
});

test("Record on the other profile's tab takes the control and starts the session there", async () => {
  const peer = fakePeerClient(statusOf("connected"));
  const { root, sent, pips } = mount(peer);
  await expect.poll(() => button(remote(root) ?? root, "Record")).toBeDefined();
  button(remote(root) ?? root, "Record")?.click();

  await expect
    .poll(() => peer.asked("session-start"))
    .toEqual([{ type: "session-start", peer: BOB_ID, tabId: MAIL.id }]);
  expect(pips).toHaveLength(1);
  expect(await tryHoldLock(CONTROL_LOCK)).toBeUndefined();
  expect(sent).toEqual([]);

  pips[0]?.close();
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
  expect(pairingSection(root)).toBeNull();
});
