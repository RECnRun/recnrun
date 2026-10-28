import { render } from "preact";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { PeerStatus } from "@/messaging/peer-results";
import { loadFolder } from "@/p2p/folder-store";
import { PairingPage } from "@/pairing/PairingPage";
import { fakePeerClient, statusOf } from "./fake-peer-client";
import { alerts } from "./pairing-page";
import { button } from "./queries";

const FOLDER = "pairing-page-folder";

/** A fresh folder in the origin's private file system, standing in for Documents/RECnRun. */
async function privateFolder() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(FOLDER, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(FOLDER, { create: true });
}

const unpaired = (folder: PeerStatus["folder"], folderPairing = false): PeerStatus => ({
  ...statusOf(),
  folder,
  folderPairing,
});

/** Alice's pairing page, whose picker answers with `pick`. */
async function mount(
  peer: ReturnType<typeof fakePeerClient>,
  pick: () => Promise<FileSystemDirectoryHandle>,
) {
  const root = document.body.appendChild(document.createElement("div"));
  render(<PairingPage client={peer.client} copy={async () => {}} pick={pick} />, root);
  await expect.poll(() => section(root)).toBeDefined();
  return root;
}

const section = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="folder-heading"]')?.textContent ?? undefined;

beforeEach(async () => {
  await new Promise((resolve) => {
    indexedDB.deleteDatabase("recnrun-p2p").onsuccess = resolve;
  });
});

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("choosing the folder keeps it and starts pairing, which then waits", async () => {
  const picked = await privateFolder();
  const peer = fakePeerClient(unpaired("none"));
  const root = await mount(peer, async () => picked);
  expect(button(root, "Pair through the folder")).toBeUndefined();
  button(root, "Choose folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  expect(await (await loadFolder())?.isSameEntry(picked)).toBe(true);
  peer.change(unpaired("granted", true));
  await expect.poll(() => section(root)).toContain("Waiting for another profile in the folder…");
  expect(button(root, "Choose another folder")).toBeDefined();
  expect(button(root, "Pair through the folder")).toBeUndefined();
});

test("a chosen folder that waits for nobody pairs again, and a verified link names the peer", async () => {
  const peer = fakePeerClient(unpaired("granted"));
  const root = await mount(peer, privateFolder);
  button(root, "Pair through the folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  peer.change({ ...statusOf("connected"), folder: "granted", folderPairing: false });
  await expect.poll(() => section(root)).toContain("Paired with Bob");
  expect(button(root, "Pair through the folder")).toBeUndefined();
});

test("a folder Chrome asks for again says so, and a picker that fails is an alert", async () => {
  const peer = fakePeerClient(unpaired("prompt"));
  const root = await mount(peer, async () => {
    throw new DOMException("The user aborted a request.", "AbortError");
  });
  expect(section(root)).toContain("Chrome asks again before RECnRun may use the folder.");
  button(root, "Choose folder")?.click();
  await expect.poll(() => alerts(root)).toEqual(["The user aborted a request."]);
  expect(peer.asked("folder-pair")).toEqual([]);
});
