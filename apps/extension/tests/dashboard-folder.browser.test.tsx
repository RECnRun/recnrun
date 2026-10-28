import { afterEach, expect, test } from "vite-plus/test";
import { render } from "preact";
import { FolderBanner, PairControls } from "@/dashboard/FolderPairing";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerServices } from "@/views/remote-peer";
import { memoryRecordingStore } from "./fake-extension";
import { fakePeerClient, statusOf } from "./fake-peer-client";
import { fakeTabs } from "./fake-tabs";
import { alertText } from "./dashboard-page";
import { button } from "./queries";

/** The dashboard's folder banner and pairing controls, as Alice's status has them. */
function mount(status: PeerStatus, answers: Parameters<typeof fakePeerClient>[1] = {}) {
  const peer = fakePeerClient(status, answers);
  const opened = { folder: 0, pairing: 0 };
  const peers: PeerServices = {
    client: peer.client,
    tabs: fakeTabs({ tabs: [] }).source,
    recordings: memoryRecordingStore(),
    openPairing: async () => void opened.pairing++,
    openFolder: async () => void opened.folder++,
  };
  const root = document.body.appendChild(document.createElement("div"));
  const show = (next: PeerStatus | undefined) =>
    render(
      <>
        <FolderBanner peers={peers} status={next} />
        <PairControls peers={peers} status={next} />
      </>,
      root,
    );
  show(status);
  return { peer, opened, root, show };
}

const banner = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="folder-banner-heading"]')?.textContent ?? undefined;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("without the folder, the banner opens the window that chooses it", async () => {
  const { opened, root, show } = mount({ ...statusOf(), folder: "none" });
  expect(banner(root)).toContain("Choose the RECnRun folder");
  expect(button(root, "Pair with another profile")).toBeUndefined();
  button(root, "Choose folder")?.click();
  await expect.poll(() => opened.folder).toBe(1);
  show({ ...statusOf(), folder: "prompt" });
  expect(banner(root)).toContain("Allow the RECnRun folder");
  button(root, "Allow folder")?.click();
  await expect.poll(() => opened.folder).toBe(2);
  show(statusOf());
  expect(banner(root)).toBeUndefined();
  show(undefined);
  expect(banner(root)).toBeUndefined();
  expect(button(root, "Manage pairing")).toBeDefined();
});

test("an unpaired profile pairs from the dashboard, then waits in the folder", async () => {
  const { peer, opened, root, show } = mount(statusOf());
  button(root, "Pair with another profile")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  show({ ...statusOf(), folderPairing: true });
  expect(root.textContent).toContain("Waiting for another profile in the RECnRun folder…");
  expect(button(root, "Pair with another profile")).toBeUndefined();
  button(root, "Manage pairing")?.click();
  await expect.poll(() => opened.pairing).toBe(1);
});

test("a paired profile that stopped waiting reconnects from the dashboard", async () => {
  const { peer, root, show } = mount(statusOf("disconnected"));
  button(root, "Reconnect")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
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
