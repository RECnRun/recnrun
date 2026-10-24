import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { PeerStatus } from "@/pairing/PairingPage";
import { startPairing } from "@/pairing/start";
import { button } from "./queries";

const IDLE: PeerStatus = {
  identity: { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Home" },
  peer: null,
  link: { state: "idle", verified: false },
};

const PREVIEW = {
  kind: "offer",
  profileId: "22222222-2222-4222-8222-222222222222",
  displayName: "Work",
  sas: "042137",
  known: false,
};

type Answers = Record<string, (request: Record<string, unknown>) => unknown>;

function mount(answers: Answers = {}, ancestors: string[] = []) {
  let status = IDLE;
  let notify = () => {};
  const asked: Record<string, unknown>[] = [];
  const ask = vi.fn(async (request: { type: string; [key: string]: unknown }) => {
    asked.push(request);
    if (request.type === "peer-status") return status;
    const answer = answers[request.type];
    return answer ? answer(request) : null;
  });
  const root = document.body.appendChild(document.createElement("div"));
  const page = { location: { ancestorOrigins: ancestors } } as unknown as Window;
  startPairing(root, { ask, watch: (onChange) => ((notify = onChange), () => {}) }, page);
  const change = (next: PeerStatus) => {
    status = next;
    notify();
  };
  return { root, asked, change };
}

const typeInto = (field: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

const statusText = (root: HTMLElement) =>
  root.querySelector('[aria-label="Link status"]')?.textContent;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("shows this profile and follows the link status", async () => {
  const { root, change } = mount();
  await vi.waitFor(() => expect(statusText(root)).toBe("Not connected"));
  expect(root.textContent).toContain(IDLE.identity.profileId);
  change({
    ...IDLE,
    peer: { profileId: PREVIEW.profileId, displayName: "Work" },
    link: { state: "connected", verified: true },
  });
  await vi.waitFor(() => expect(statusText(root)).toBe("Connected — Work"));
  change({ ...IDLE, link: { state: "failed", verified: false } });
  await vi.waitFor(() => expect(statusText(root)).toBe("Error"));
});

test("creates an offer to copy", async () => {
  const { root } = mount({ "peer-create-offer": () => ({ code: "RECNRUN-PAIR-1.offer" }) });
  await vi.waitFor(() => expect(button(root, "Create offer")).toBeDefined());
  button(root, "Create offer")?.click();
  await vi.waitFor(() =>
    expect(root.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toBe(
      "RECNRUN-PAIR-1.offer",
    ),
  );
  expect(button(root, "Copy offer")).toBeDefined();
});

test("shows who sent a code and the digits to compare before accepting it", async () => {
  const { root, asked } = mount({
    "peer-inspect": () => PREVIEW,
    "peer-accept": () => ({ code: "RECNRUN-PAIR-1.answer" }),
  });
  await vi.waitFor(() => expect(button(root, "Import code")).toBeDefined());
  const pasted = root.querySelector<HTMLTextAreaElement>("textarea:not([readonly])");
  if (pasted) typeInto(pasted, "RECNRUN-PAIR-1.offer");
  button(root, "Import code")?.click();
  await vi.waitFor(() =>
    expect(root.querySelector('[aria-label="Pairing digits"]')?.textContent).toBe("042137"),
  );
  expect(root.textContent).toContain("Work");
  expect(asked.some(({ type }) => type === "peer-accept")).toBe(false);

  button(root, "Accept and create answer")?.click();
  await vi.waitFor(() => expect(button(root, "Copy answer")).toBeDefined());
  expect(asked).toContainEqual({ type: "peer-accept", code: "RECNRUN-PAIR-1.offer" });
  expect(root.querySelector('[aria-label="Pairing digits"]')).toBeNull();
});

test("shows why a code was refused", async () => {
  const { root } = mount({
    "peer-inspect": () => {
      throw new Error("The pairing code expired; create a new one.");
    },
  });
  await vi.waitFor(() => expect(button(root, "Import code")).toBeDefined());
  button(root, "Import code")?.click();
  await vi.waitFor(() =>
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("expired"),
  );
});

test("renames, pings, diagnoses, disconnects, and forgets", async () => {
  const { root, asked } = mount({
    "peer-ping": () => ({ latencyMs: 2 }),
    "peer-diagnostics": () => ({ diagnostics: ["candidate host (mDNS) udp", "link connected"] }),
  });
  await vi.waitFor(() => expect(button(root, "Save name")).toBeDefined());
  const name = root.querySelector<HTMLInputElement>("input");
  if (name) typeInto(name, "Laptop");
  await vi.waitFor(() => expect(name?.value).toBe("Laptop"));
  await new Promise(requestAnimationFrame);
  button(root, "Save name")?.click();
  button(root, "Send ping")?.click();
  await vi.waitFor(() => expect(root.textContent).toContain("Pong in 2 ms"));
  button(root, "Show diagnostics")?.click();
  await vi.waitFor(() =>
    expect(root.querySelector('[aria-label="Diagnostics"]')?.textContent).toContain(
      "link connected",
    ),
  );
  button(root, "Disconnect")?.click();
  button(root, "Forget the other profile")?.click();
  await vi.waitFor(() =>
    expect(asked.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["peer-rename", "peer-disconnect", "peer-forget"]),
    ),
  );
  expect(asked).toContainEqual({ type: "peer-rename", displayName: "Laptop" });
});

test("refuses to run inside another page", () => {
  const { root, asked } = mount({}, ["https://evil.example"]);
  expect(root.textContent).toContain("evil.example");
  expect(asked).toEqual([]);
});
