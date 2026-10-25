import { render } from "preact";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { PairingPreview, PeerStatus } from "@/messaging/peer-results";
import { startPairing } from "@/pairing/start";
import { ALICE, BOB, closedFor, fakePeerClient, statusOf } from "./fake-peer-client";
import { alerts, check, disabled, field, previewOf, statusText, type } from "./pairing-page";
import { button } from "./queries";

const OFFER = "RECNRUN-PAIR-1.offer";
const ANSWER = "RECNRUN-PAIR-1.answer";

function mount(client: ReturnType<typeof fakePeerClient>) {
  const root = document.body.appendChild(document.createElement("div"));
  startPairing(root, client.client);
  return root;
}

let copied: string[];

beforeEach(() => {
  copied = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    copied.push(text);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("before the background answers, or when it cannot, the page only offers to start", async () => {
  const never = fakePeerClient(statusOf(), { status: () => new Promise(() => {}) });
  const failing = fakePeerClient(statusOf(), {
    status: () => {
      throw new Error("Receiving end does not exist.");
    },
  });
  const roots = [mount(never), mount(failing)];
  await expect.poll(() => failing.asked("status")).toHaveLength(1);
  for (const root of roots) {
    expect(statusText(root)).toBe("Loading");
    expect(button(root, "Create offer")).toBeDefined();
    expect(button(root, "Save name")).toBeUndefined();
    expect(button(root, "Choose shared folder")).toBeUndefined();
  }
});

test("an unpaired profile shows its identity and renames itself", async () => {
  const peer = fakePeerClient(statusOf());
  const root = mount(peer);
  await expect.poll(() => statusText(root)).toBe("Not paired");
  expect(field(root, "display-name")?.value).toBe("Alice");
  expect(root.textContent).toContain(`Profile id ${ALICE.profileId}`);
  expect(button(root, "Send ping")).toBeUndefined();

  await type(field(root, "display-name"), "Alice at work");
  button(root, "Save name")?.click();
  await expect
    .poll(() => peer.asked("rename"))
    .toEqual([{ type: "rename", displayName: "Alice at work" }]);
});

test("an offer shows read-only for the user to copy, and buttons wait while it is created", async () => {
  let create = (_code: { code: string }) => {};
  const peer = fakePeerClient(statusOf(), {
    "create-offer": () => new Promise((resolve) => (create = resolve)),
  });
  const root = mount(peer);
  await expect.poll(() => button(root, "Save name")).toBeDefined();
  button(root, "Create offer")?.click();
  await expect.poll(() => disabled(root, "Create offer")).toBe(true);
  expect(disabled(root, "Save name")).toBe(true);

  create({ code: OFFER });
  await expect.poll(() => field(root, "offer-code")?.value).toBe(OFFER);
  expect(field(root, "offer-code")?.readOnly).toBe(true);
  expect(disabled(root, "Create offer")).toBe(false);
  button(root, "Copy offer")?.click();
  await expect.poll(() => button(root, "Copied")).toBeDefined();
  expect(copied).toEqual([OFFER]);

  // A new offer replaces the old one, which never shows while the new one is made.
  button(root, "Create offer")?.click();
  await expect.poll(() => field(root, "offer-code")).toBeUndefined();
  create({ code: `${OFFER}.2` });
  await expect.poll(() => field(root, "offer-code")?.value).toBe(`${OFFER}.2`);
});

test("an imported offer shows who made it before it is accepted, then the answer", async () => {
  const peer = fakePeerClient(statusOf(), {
    inspect: () => previewOf("offer"),
    accept: () => ({ code: ANSWER }),
  });
  const root = mount(peer);
  await expect.poll(() => disabled(root, "Import code")).toBe(true);
  await type(field(root, "import-code"), `  ${OFFER}\n`);
  button(root, "Import code")?.click();

  await expect.poll(() => check(root)).toContain("042917");
  expect(check(root)).toContain(BOB.displayName);
  expect(check(root)).toContain(BOB.profileId);
  expect(check(root)).not.toContain("already paired");
  expect(peer.asked("inspect")).toEqual([{ type: "inspect", code: OFFER }]);
  expect(peer.asked("accept")).toEqual([]);

  button(root, "Accept and create answer")?.click();
  await expect.poll(() => field(root, "answer-code")?.value).toBe(ANSWER);
  expect(peer.asked("accept")).toEqual([{ type: "accept", code: OFFER }]);
  expect(button(root, "Accept and create answer")).toBeUndefined();
  expect(check(root)).toContain("042917");
  expect(field(root, "import-code")?.value).toBe("");
  button(root, "Copy answer")?.click();
  await expect.poll(() => copied).toEqual([ANSWER]);
});

test("a confirmed answer ends the pairing with no code to hand back", async () => {
  const peer = fakePeerClient(statusOf("connecting"), {
    inspect: () => previewOf("answer", true),
  });
  const root = mount(peer);
  await type(field(root, "import-code"), ANSWER);
  button(root, "Import code")?.click();
  await expect.poll(() => check(root)).toContain("This is the profile already paired.");

  button(root, "Confirm and connect")?.click();
  await expect.poll(() => button(root, "Confirm and connect")).toBeUndefined();
  expect(peer.asked("accept")).toEqual([{ type: "accept", code: ANSWER }]);
  expect(field(root, "answer-code")).toBeUndefined();
});

test("a new code hides the previous code's check until the background checks it", async () => {
  let inspected = (_preview: PairingPreview) => {};
  const peer = fakePeerClient(statusOf(), {
    inspect: () => new Promise((resolve) => (inspected = resolve)),
  });
  const root = mount(peer);
  await type(field(root, "import-code"), OFFER);
  button(root, "Import code")?.click();
  await expect.poll(() => peer.asked("inspect")).toHaveLength(1);
  inspected(previewOf("offer"));
  await expect.poll(() => button(root, "Accept and create answer")).toBeDefined();

  await type(field(root, "import-code"), ANSWER);
  button(root, "Import code")?.click();
  await expect.poll(() => check(root)).toBeUndefined();
  inspected(previewOf("answer"));
  await expect.poll(() => button(root, "Confirm and connect")).toBeDefined();
});

test("a code the background refuses is an alert", async () => {
  const peer = fakePeerClient(statusOf(), {
    inspect: () => {
      throw new Error("The pairing code expired; create a new one.");
    },
  });
  const root = mount(peer);
  await type(field(root, "import-code"), OFFER);
  button(root, "Import code")?.click();
  await expect.poll(() => alerts(root)).toEqual(["The pairing code expired; create a new one."]);
  expect(check(root)).toBeUndefined();
});

test("the link's state names the peer only once its certificate is checked", async () => {
  const peer = fakePeerClient(statusOf("connecting"));
  const root = mount(peer);
  const states: [PeerStatus, string][] = [
    [statusOf("connecting"), "Connecting — Bob"],
    [statusOf("connected", false), "Checking the other profile"],
    [statusOf("connected"), "Connected — Bob"],
    [statusOf("disconnected"), "Disconnected — Bob"],
    [closedFor("disconnected", "closed-here"), "Disconnected — Bob"],
    [closedFor("disconnected", "closed-by-peer"), "Disconnected by Bob"],
    [statusOf("failed"), "Not reachable — Bob"],
    [closedFor("failed", "certificate"), "Error — Bob"],
    [statusOf("idle"), "Disconnected — Bob"],
  ];
  for (const [status, text] of states) {
    peer.change(status);
    await expect.poll(() => statusText(root)).toBe(text);
  }
});

test("only a verified link pings or disconnects; forget and diagnostics work at any time", async () => {
  const peer = fakePeerClient(statusOf("connected", false), {
    ping: () => ({ latencyMs: 12 }),
    diagnostics: () => ({ state: "connected", diagnostics: ["ice: connected", "dtls: ok"] }),
  });
  const root = mount(peer);
  await expect.poll(() => button(root, "Send ping")).toBeDefined();
  expect(disabled(root, "Send ping")).toBe(true);
  expect(disabled(root, "Disconnect")).toBe(true);
  expect(disabled(root, "Forget the other profile")).toBe(false);

  peer.change(statusOf("connected"));
  await expect.poll(() => disabled(root, "Send ping")).toBe(false);
  button(root, "Send ping")?.click();
  await expect.poll(() => root.textContent).toContain("Pong in 12 ms");
  button(root, "Disconnect")?.click();
  await expect.poll(() => root.textContent).not.toContain("Pong in");
  button(root, "Show diagnostics")?.click();
  await expect
    .poll(() => root.querySelector('pre[aria-label="Diagnostics"]')?.textContent)
    .toBe("ice: connected\ndtls: ok");
  button(root, "Forget the other profile")?.click();
  await expect.poll(() => peer.asked("forget")).toHaveLength(1);
  expect(peer.asked("disconnect")).toHaveLength(1);
});
