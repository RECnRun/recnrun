import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { PairingPage } from "@/pairing/PairingPage";
import { folderSignaling, signalFileOf } from "@/pairing/folder-signaling";
import { ALICE, BOB, fakePeerClient, pairingCode, statusOf } from "./fake-peer-client";
import { alerts, check, disabled, previewOf } from "./pairing-page";
import { button } from "./queries";

const PAIRING = "44444444-4444-4444-8444-444444444444";
/** Polling looks once a second, so a file shows up within a couple of seconds. */
const SOON = { timeout: 3000 };

const created: string[] = [];

/** A fresh folder in the origin's private file system, as the user would pick in both profiles. */
async function sharedFolder() {
  const name = crypto.randomUUID();
  created.push(name);
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

/** Alice's pairing page, with `folder` as the folder she picks. */
async function mount(peer: ReturnType<typeof fakePeerClient>, folder: FileSystemDirectoryHandle) {
  const root = document.body.appendChild(document.createElement("div"));
  render(
    <PairingPage client={peer.client} copy={async () => {}} pick={async () => folder} />,
    root,
  );
  await expect.poll(() => button(root, "Choose shared folder")).toBeDefined();
  button(root, "Choose shared folder")?.click();
  await expect.poll(() => button(root, "Choose another folder")).toBeDefined();
  return root;
}

const waitingText = (root: HTMLElement) =>
  root.querySelector('section[aria-labelledby="folder-heading"]')?.textContent;

afterEach(async () => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
  const opfs = await navigator.storage.getDirectory();
  for (const name of created.splice(0)) await opfs.removeEntry(name, { recursive: true });
});

test("an offer Bob leaves in the folder imports, and Alice's answer goes back through it", async () => {
  const folder = await sharedFolder();
  const bob = folderSignaling(folder, BOB.profileId);
  const answer = pairingCode("answer", ALICE, PAIRING);
  const peer = fakePeerClient(statusOf(), {
    inspect: () => previewOf("offer"),
    accept: () => ({ code: answer }),
  });
  const root = await mount(peer, folder);

  button(root, "Find an offer in the folder")?.click();
  await expect
    .poll(() => waitingText(root))
    .toContain("Looking for an offer from the other profile…");
  expect(disabled(root, "Find an offer in the folder")).toBe(true);
  expect(disabled(root, "Publish offer to the folder")).toBe(true);

  const offer = pairingCode("offer", BOB, PAIRING);
  await bob.publish(signalFileOf(offer));
  await expect.poll(() => check(root), SOON).toContain("042917");
  expect(peer.asked("inspect")).toEqual([{ type: "inspect", code: offer }]);
  expect(waitingText(root)).not.toContain("Looking for an offer");
  expect(disabled(root, "Find an offer in the folder")).toBe(false);

  button(root, "Accept and create answer")?.click();
  await expect.poll(async () => (await bob.find("answer", PAIRING))?.code).toBe(answer);

  // Once the link connects, Alice's files leave the folder.
  peer.change(statusOf("connected"));
  await expect.poll(async () => bob.find("answer", PAIRING)).toBeUndefined();
});

test("an offer Alice publishes waits for Bob's answer, which she confirms", async () => {
  const folder = await sharedFolder();
  const bob = folderSignaling(folder, BOB.profileId);
  const offer = pairingCode("offer", ALICE, PAIRING);
  const peer = fakePeerClient(statusOf(), {
    "create-offer": () => ({ code: offer }),
    inspect: () => previewOf("answer"),
  });
  const root = await mount(peer, folder);

  button(root, "Publish offer to the folder")?.click();
  await expect.poll(() => waitingText(root)).toContain("Waiting for the other profile's answer…");
  expect((await bob.find("offer"))?.code).toBe(offer);

  // An answer to another pairing is not the one Alice waits for.
  await bob.publish(signalFileOf(pairingCode("answer", BOB, crypto.randomUUID())));
  const answer = pairingCode("answer", BOB, PAIRING);
  await bob.publish(signalFileOf(answer));
  await expect.poll(() => check(root), SOON).toContain(BOB.displayName);
  expect(peer.asked("inspect")).toEqual([{ type: "inspect", code: answer }]);

  button(root, "Confirm and connect")?.click();
  await expect.poll(() => button(root, "Confirm and connect")).toBeUndefined();
  expect(peer.asked("accept")).toEqual([{ type: "accept", code: answer }]);
  // Confirming an answer makes no code, so nothing more goes into the folder.
  expect(await bob.find("answer")).toBeUndefined();
});

test("an offer nobody answers before it expires stops the wait with an alert", async () => {
  const peer = fakePeerClient(statusOf(), {
    "create-offer": () => ({ code: pairingCode("offer", ALICE, PAIRING, 1500) }),
  });
  const root = await mount(peer, await sharedFolder());
  button(root, "Publish offer to the folder")?.click();
  await expect.poll(() => waitingText(root)).toContain("Waiting for the other profile's answer…");

  await expect
    .poll(() => alerts(root), { timeout: 4000 })
    .toEqual(["Nothing came through the folder in time."]);
  expect(waitingText(root)).not.toContain("Waiting for");
  expect(disabled(root, "Publish offer to the folder")).toBe(false);

  // A new wait clears the old problem.
  button(root, "Find an offer in the folder")?.click();
  await expect.poll(() => alerts(root)).toEqual([]);
});

test("a folder that cannot be picked, or an offer the background does not make, is an alert", async () => {
  const peer = fakePeerClient(statusOf(), { "create-offer": () => ({}) });
  const root = document.body.appendChild(document.createElement("div"));
  const refuse = async (): Promise<FileSystemDirectoryHandle> => {
    throw new Error("The user aborted a request.");
  };
  render(<PairingPage client={peer.client} copy={async () => {}} pick={refuse} />, root);
  await expect.poll(() => button(root, "Choose shared folder")).toBeDefined();
  button(root, "Choose shared folder")?.click();
  await expect.poll(() => alerts(root)).toEqual(["The user aborted a request."]);
  expect(button(root, "Publish offer to the folder")).toBeUndefined();

  const other = await mount(peer, await sharedFolder());
  button(other, "Publish offer to the folder")?.click();
  await expect.poll(() => alerts(other)).toEqual(["No offer was created."]);
  expect(waitingText(other)).not.toContain("Waiting for");
});
