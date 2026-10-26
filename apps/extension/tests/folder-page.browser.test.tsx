import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "preact";
import type { PeerStatus } from "@/messaging/peer-results";
import { loadFolder } from "@/p2p/folder-store";
import { FolderPage } from "@/pairing/FolderPage";
import { startPairing } from "@/pairing/start";
import { fakePeerClient, statusOf } from "./fake-peer-client";
import { alerts } from "./pairing-page";
import { button } from "./queries";

const withFolder = (folder: PeerStatus["folder"]): PeerStatus => ({ ...statusOf(), folder });

async function privateFolder() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("folder-page", { recursive: true }).catch(() => {});
  return root.getDirectoryHandle("folder-page", { create: true });
}

function mount(folder: PeerStatus["folder"], allow = vi.fn(async () => {})) {
  const peer = fakePeerClient(withFolder(folder));
  const close = vi.fn();
  const root = document.body.appendChild(document.createElement("div"));
  render(
    <FolderPage client={peer.client} pick={privateFolder} allow={allow} close={close} />,
    root,
  );
  return { peer, close, root, allow };
}

beforeEach(async () => {
  await new Promise((resolve) => {
    indexedDB.deleteDatabase("recnrun-p2p").onsuccess = resolve;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("choosing the folder keeps it, starts pairing, and closes the window", async () => {
  const { peer, close, root } = mount("none");
  // The button waits for the background's answer.
  await expect.poll(() => button(root, "Choose folder")?.disabled).toBe(false);
  button(root, "Choose folder")?.click();
  await expect.poll(() => close.mock.calls).toHaveLength(1);
  expect(peer.asked("folder-pair")).toHaveLength(1);
  expect(await loadFolder()).toBeDefined();
});

test("after a restart, it asks Chrome again for the folder instead of choosing one", async () => {
  const { peer, close, root, allow } = mount("prompt");
  await expect.poll(() => button(root, "Allow folder")).toBeDefined();
  expect(root.textContent).toContain("Allow on every visit");
  button(root, "Allow folder")?.click();
  await expect.poll(() => close.mock.calls).toHaveLength(1);
  expect(allow).toHaveBeenCalledOnce();
  expect(peer.asked("folder-pair")).toHaveLength(1);
});

test("a folder Chrome does not allow is an alert, and the window stays", async () => {
  const refused = vi.fn(async () => {
    throw new Error("Chrome did not allow RECnRun to use the folder.");
  });
  const { peer, close, root } = mount("prompt", refused);
  await expect.poll(() => button(root, "Allow folder")).toBeDefined();
  button(root, "Allow folder")?.click();
  await expect
    .poll(() => alerts(root))
    .toEqual(["Chrome did not allow RECnRun to use the folder."]);
  expect(close).not.toHaveBeenCalled();
  expect(peer.asked("folder-pair")).toEqual([]);
});

test("the pairing page opened for the folder shows only the folder, with Chrome's prompts", async () => {
  const picked = await privateFolder();
  vi.stubGlobal("showDirectoryPicker", async () => picked);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const peer = fakePeerClient(withFolder("none"));
  const root = document.body.appendChild(document.createElement("div"));
  startPairing(root, peer.client, "#folder");
  await expect.poll(() => root.querySelector("h1")?.textContent).toBe("RECnRun folder");
  expect(root.textContent).not.toContain("Pair by hand instead");
  await expect.poll(() => button(root, "Choose folder")?.disabled).toBe(false);
  button(root, "Choose folder")?.click();
  await expect.poll(() => close.mock.calls).toHaveLength(1);
  // After a restart, the kept folder is asked for again; Chrome grants a private one at once.
  peer.change(withFolder("prompt"));
  await expect.poll(() => button(root, "Allow folder")?.disabled).toBe(false);
  button(root, "Allow folder")?.click();
  await expect.poll(() => close.mock.calls).toHaveLength(2);
  expect(peer.asked("folder-pair")).toHaveLength(2);
});
