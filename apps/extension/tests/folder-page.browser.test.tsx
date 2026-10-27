import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "preact";
import type { PeerStatus } from "@/messaging/peer-results";
import { loadFolder } from "@/p2p/folder-store";
import { FolderPage } from "@/folder/FolderPage";
import { startFolder } from "@/folder/start";
import { CAROL_ID, fakePeerClient, statusOf, withCarol } from "./fake-peer-client";
import { alerts, button } from "./queries";

const withFolder = (folder: PeerStatus["folder"]): PeerStatus => ({ ...statusOf(), folder });
const paired = (): PeerStatus => ({ ...statusOf("connected"), folderPairing: true });
const WAIT = "Keep this window open";

async function privateFolder() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("folder-page", { recursive: true }).catch(() => {});
  return root.getDirectoryHandle("folder-page", { create: true });
}

function mount(
  folder: PeerStatus["folder"],
  allow = vi.fn(async () => {}),
  status = withFolder(folder),
) {
  const peer = fakePeerClient(status);
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

test("choosing the folder keeps it, starts pairing, and the window waits until paired", async () => {
  const { peer, close, root } = mount("none");
  // The button waits for the background's answer.
  await expect.poll(() => button(root, "Choose folder")?.disabled).toBe(false);
  button(root, "Choose folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  expect(await loadFolder()).toBeDefined();
  // Chrome keeps the folder's grant only while a page of the extension is open.
  await expect.poll(() => root.textContent).toContain(WAIT);
  expect(button(root, "Choose folder")).toBeUndefined();
  expect(close).not.toHaveBeenCalled();
  peer.change(paired());
  await expect.poll(() => close.mock.calls).toHaveLength(1);
});

test("once the grant ended, it asks Chrome again for the folder instead of choosing one", async () => {
  let released = -1;
  const { peer, close, root, allow } = mount(
    "prompt",
    vi.fn(async () => {
      released = peer.asked("folder-release").length;
    }),
  );
  await expect.poll(() => button(root, "Allow folder")).toBeDefined();
  expect(root.textContent).toContain("Allow on every visit");
  button(root, "Allow folder")?.click();
  await expect.poll(() => peer.asked("folder-pair")).toHaveLength(1);
  expect(allow).toHaveBeenCalledOnce();
  // Chrome offers "Allow on every visit" only once no old handle holds the picker's grant.
  expect(released).toBe(1);
  await expect.poll(() => root.textContent).toContain(WAIT);
  expect(close).not.toHaveBeenCalled();
  peer.change(paired());
  await expect.poll(() => close.mock.calls).toHaveLength(1);
});

test("opened while linked, the window lets one more profile join, then closes", async () => {
  const linked = { ...statusOf("connected"), folder: "prompt" as const, folderPairing: true };
  const { peer, close, root } = mount("prompt", undefined, linked);
  await expect.poll(() => button(root, "Allow folder")).toBeDefined();
  expect(root.textContent).toContain("so another profile can join");
  button(root, "Allow folder")?.click();
  await expect.poll(() => root.textContent).toContain(WAIT);
  peer.change({ ...linked, folder: "granted" });
  await expect.poll(() => root.textContent).toContain("In Documents");
  expect(close).not.toHaveBeenCalled();
  peer.change({ ...withCarol(linked), folder: "granted" });
  await expect.poll(() => close.mock.calls).toHaveLength(1);
});

test("a newcomer's window stays open until it linked every profile waiting in the folder", async () => {
  const { peer, close, root } = mount("none");
  await expect.poll(() => button(root, "Choose folder")?.disabled).toBe(false);
  button(root, "Choose folder")?.click();
  await expect.poll(() => root.textContent).toContain(WAIT);
  // Linked to Bob, while Carol still waits in the folder: closing would end the grant she needs.
  const asked = peer.asked("status").length;
  peer.change({ ...paired(), unpaired: [CAROL_ID] });
  await expect.poll(() => peer.asked("status").length).toBeGreaterThan(asked);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(root.textContent).toContain(WAIT);
  expect(close).not.toHaveBeenCalled();
  peer.change(withCarol(paired()));
  await expect.poll(() => close.mock.calls).toHaveLength(1);
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

test("the extension's only page is the folder window, with Chrome's prompts", async () => {
  const picked = await privateFolder();
  vi.stubGlobal("showDirectoryPicker", async () => picked);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const peer = fakePeerClient(withFolder("none"));
  const root = document.body.appendChild(document.createElement("div"));
  startFolder(root, peer.client);
  await expect.poll(() => root.querySelector("h1")?.textContent).toBe("RECnRun folder");
  expect(root.textContent).not.toContain("Pair by hand instead");
  await expect.poll(() => button(root, "Choose folder")?.disabled).toBe(false);
  button(root, "Choose folder")?.click();
  await expect.poll(() => root.textContent).toContain(WAIT);
  peer.change(paired());
  await expect.poll(() => close.mock.calls).toHaveLength(1);
  // Once the grant ended, the kept folder is asked for again; Chrome grants a private one at once.
  peer.change(withFolder("prompt"));
  await expect.poll(() => button(root, "Allow folder")?.disabled).toBe(false);
  button(root, "Allow folder")?.click();
  await expect.poll(() => root.textContent).toContain(WAIT);
  peer.change(paired());
  await expect.poll(() => close.mock.calls).toHaveLength(2);
  expect(peer.asked("folder-pair")).toHaveLength(2);
});
