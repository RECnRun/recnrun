import { afterEach, expect, test, vi } from "vite-plus/test";
import { render } from "preact";
import { FolderBanner, PairingSection } from "@/dashboard/FolderPairing";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerServices } from "@/views/remote-peer";
import { memoryRecordingStore } from "./fake-extension";
import { BOB_ID, closedFor, fakePeerClient, pausedBob, statusOf } from "./fake-peer-client";
import { fakeTabs } from "./fake-tabs";
import { alertText } from "./dashboard-page";
import { button, field, type } from "./queries";

/** The dashboard's folder banner and pairing controls, as Alice's status has them. */
function mount(status: PeerStatus, answers: Parameters<typeof fakePeerClient>[1] = {}) {
  const peer = fakePeerClient(status, answers);
  // What the folder steps saw of the requests the background already had.
  const grants: string[] = [];
  const asked = () => peer.asked("folder-release").length;
  const peers: PeerServices = {
    client: peer.client,
    tabsOf: () => fakeTabs({ tabs: [] }).source,
    recordingsOf: () => memoryRecordingStore(),
    recordings: memoryRecordingStore(),
    sessionTabs: fakeTabs({ tabs: [] }).source,
    chooseFolder: vi.fn(async () => void grants.push(`choose after ${asked()} releases`)),
    allowFolder: vi.fn(async () => void grants.push(`allow after ${asked()} releases`)),
  };
  const root = document.body.appendChild(document.createElement("div"));
  const show = (next: PeerStatus | undefined) =>
    render(
      <>
        <FolderBanner peers={peers} status={next} />
        <PairingSection peers={peers} status={next} />
      </>,
      root,
    );
  show(status);
  return { peer, peers, grants, root, show };
}

const banner = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="folder-banner-heading"]')?.textContent ?? undefined;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("without the folder, the banner shows Chrome's picker in the click, then pairing starts", async () => {
  const { peer, grants, root, show } = mount({ ...statusOf(), folder: "none" });
  expect(banner(root)).toContain("Choose the RECnRun folder");
  expect(button(root, "Pair with another profile")).toBeUndefined();
  button(root, "Choose folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  expect(grants).toEqual(["choose after 0 releases"]);
  // Connected, the profile needs the folder only once the link drops.
  show({ ...statusOf("connected"), folder: "prompt" });
  expect(banner(root)).toBeUndefined();
  show(statusOf());
  expect(banner(root)).toBeUndefined();
  show(undefined);
  expect(banner(root)).toBeUndefined();
});

test("once the grant ended, the banner asks Chrome again, on every visit, after the old handles go", async () => {
  const { peer, grants, root } = mount({ ...statusOf(), folder: "prompt" });
  expect(banner(root)).toContain("Allow the RECnRun folder");
  expect(banner(root)).toContain("Allow on every visit");
  button(root, "Allow folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  // Chrome offers "Allow on every visit" only once no old handle holds the picker's grant.
  expect(grants).toEqual(["allow after 1 releases"]);
});

test("a folder Chrome does not allow, or a picker the user cancels, is an alert, and pairing waits", async () => {
  const { peer, peers, root } = mount({ ...statusOf(), folder: "prompt" });
  vi.mocked(peers.allowFolder).mockRejectedValueOnce(
    new Error("Chrome did not allow RECnRun to use the folder."),
  );
  button(root, "Allow folder")?.click();
  await expect.poll(() => alertText(root)).toBe("Chrome did not allow RECnRun to use the folder.");
  expect(button(root, "Allow folder")?.disabled).toBe(false);
  expect(peer.asked("folder-pair")).toEqual([]);
});

test("a linked profile without the folder lets another profile join, from the pairing section", async () => {
  const { peer, grants, root, show } = mount({ ...statusOf("connected"), folder: "prompt" });
  expect(banner(root)).toBeUndefined();
  button(root, "Let another profile join")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  expect(grants).toEqual(["allow after 1 releases"]);
  show(statusOf("connected"));
  expect(button(root, "Let another profile join")).toBeUndefined();
  show({ ...statusOf(), folder: "prompt" });
  expect(button(root, "Let another profile join")).toBeUndefined();
});

test("an unpaired profile pairs from the dashboard, then waits in the folder", async () => {
  const { peer, root, show } = mount(statusOf());
  button(root, "Pair with another profile")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  show({ ...statusOf(), folderPairing: true });
  expect(root.textContent).toContain("Waiting for another profile in the RECnRun folder…");
  expect(button(root, "Pair with another profile")).toBeUndefined();
});

test("a peer the user disconnected reconnects from the dashboard", async () => {
  const { peer, root, show } = mount(pausedBob(statusOf("disconnected")));
  button(root, "Reconnect")?.click();
  await expect.poll(() => peer.asked("reconnect")).toEqual([{ type: "reconnect", peer: BOB_ID }]);
  show({ ...statusOf("disconnected"), folderPairing: true });
  expect(root.textContent).toContain("Waiting for Bob in the RECnRun folder…");
  show({ ...statusOf("connected"), folderPairing: true });
  expect(root.textContent).not.toContain("Waiting");
  expect(button(root, "Reconnect")).toBeUndefined();
});

test("pairing that fails is an alert", async () => {
  const { root } = mount(statusOf(), {
    "folder-pair": () => {
      throw new Error("Choose the RECnRun folder first.");
    },
  });
  button(root, "Pair with another profile")?.click();
  await expect.poll(() => alertText(root)).toBe("Choose the RECnRun folder first.");
});

const pairingText = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="pairing-heading"] [role="status"]')?.textContent;

test("the pairing section says how the link stands, and renames this profile", async () => {
  const { peer, root, show } = mount(statusOf());
  expect(pairingText(root)).toBe("Not paired");
  expect(field(root, "profile-name")?.value).toBe("Alice");
  await type(field(root, "profile-name"), "Alice at work");
  button(root, "Save name")?.click();
  await expect
    .poll(() => peer.asked("rename"))
    .toEqual([{ type: "rename", displayName: "Alice at work" }]);
  show(statusOf("connected", false));
  expect(pairingText(root)).toBe("Checking Bob");
  show(statusOf("connected"));
  expect(pairingText(root)).toBe("Connected — Bob");
  show(closedFor("disconnected", "closed-by-peer"));
  expect(pairingText(root)).toBe("Disconnected by Bob");
});

test("a connected profile disconnects, and a paired one forgets its peer, from the dashboard", async () => {
  const { peer, root, show } = mount(statusOf("connected"));
  expect(button(root, "Reconnect")).toBeUndefined();
  button(root, "Disconnect")?.click();
  await expect.poll(() => peer.asked("disconnect")).toEqual([{ type: "disconnect", peer: BOB_ID }]);
  show(pausedBob(statusOf("disconnected")));
  // Disconnected, the dashboard offers the folder step again.
  expect(button(root, "Disconnect")).toBeUndefined();
  expect(button(root, "Reconnect")).toBeDefined();
  button(root, "Forget Bob")?.click();
  await expect.poll(() => peer.asked("forget")).toEqual([{ type: "forget", peer: BOB_ID }]);
  show(statusOf());
  expect(button(root, "Forget Bob")).toBeUndefined();
});
