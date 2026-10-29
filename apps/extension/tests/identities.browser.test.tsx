import type { Identity } from "@recnrun/domain";
import { expect, test } from "vite-plus/test";
import { approximateSize } from "@/dashboard/Identities";
import { NO_INCOGNITO_WINDOW } from "./fake-extension";
import { PRIVATE, SHOP } from "./fake-tabs";
import { button } from "./queries";
import { alertText, enabledButtons, inPanel, mount, panelText } from "./workspace-panel";

const AT = Date.UTC(2026, 9, 28, 12, 30);
const ADMIN: Identity = {
  id: "admin",
  label: "Admin",
  url: "https://app.example/",
  created: 1,
  lastCapture: { id: "cap-1", at: AT, bytes: 1536 },
};
const GUEST: Identity = { ...ADMIN, id: "guest", label: "Guest", lastCapture: undefined };
const SAVED = { ...NO_INCOGNITO_WINDOW, identities: [ADMIN, GUEST] };
const CONFLICT = "Another Incognito window or tab is open. Close it to switch identities";
const managedBy = (identityId?: string) => ({
  generation: 1,
  windowId: 3,
  tabId: 30,
  status: "active" as const,
  ...(identityId !== undefined && { identityId }),
});

const identityRow = (root: HTMLElement, label: string) =>
  root.querySelector<HTMLElement>(`ul[aria-label="Saved identities"] li[aria-label="${label}"]`) ??
  undefined;
const inRow = (root: HTMLElement, label: string, name: string) => {
  const found = identityRow(root, label);
  return found ? button(found, name) : undefined;
};

test("sizes read approximately, in binary units", () => {
  expect([8, 1536, 5 * 1024 * 1024].map(approximateSize)).toEqual([
    "about 8 B",
    "about 1.5 KB",
    "about 5.0 MB",
  ]);
});

test("lists each saved identity with its last capture's time and size, and where it is kept", async () => {
  const { root } = mount(SAVED);
  await expect.poll(() => identityRow(root, "Admin")).toBeDefined();
  expect(identityRow(root, "Admin")?.textContent).toContain(
    `Saved ${new Date(AT).toLocaleString()}, about 1.5 KB`,
  );
  expect(identityRow(root, "Guest")?.textContent).toContain("Not saved yet");
  expect(panelText(root)).toContain(
    "Saved on this computer in RECnRun, kept after Incognito closes.",
  );
});

test("names each visited origin a save or restore left out on its identity's row", async () => {
  const note = { reason: "The page did not load (net::ERR_EMPTY_RESPONSE).", kept: false };
  const skipped = [
    { ...note, origin: "https://sso.example", work: "save", step: "navigate" },
    { ...note, origin: "https://cdn.example", work: "save", step: "not-restored", kept: true },
    { ...note, origin: "https://api.example", work: "restore", step: "restore" },
    { ...note, origin: "https://img.example", work: "save", step: "save" },
  ] as const;
  const { root } = mount({ ...SAVED, identities: [{ ...ADMIN, skipped: [...skipped] }, GUEST] });
  await expect.poll(() => identityRow(root, "Admin")).toBeDefined();
  const notes = [...(identityRow(root, "Admin")?.querySelectorAll(".identity-skipped") ?? [])];
  expect(notes.map((each) => each.textContent)).toEqual([
    "Not saved: storage of https://sso.example (the site did not answer).",
    "Not saved: storage of https://cdn.example (the last start could not restore it); its last saved storage is kept.",
    "Not restored: storage of https://api.example (its page did not take its data).",
    "Not saved: storage of https://img.example (its page did not hand over its data).",
  ]);
  expect(identityRow(root, "Guest")?.querySelector(".identity-skipped")).toBeNull();
});

test("with nothing open, Switch to restores a saved identity and opens one never saved empty", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inRow(root, "Admin", "Switch to")).toBeDefined();
  expect(inRow(root, "Admin", "Resume")).toBeUndefined();
  inRow(root, "Admin", "Switch to")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-resume", identityId: "admin" }]);
  inRow(root, "Guest", "Switch to")?.click();
  await expect.poll(() => sent.at(-1)).toEqual({ type: "workspace-switch", identityId: "guest" });
});

test("the open identity is marked Open and closes, and cannot be deleted; others switch", async () => {
  const { root, sent } = mount({ ...SAVED, managed: managedBy("admin") });
  await expect.poll(() => inRow(root, "Admin", "Close")).toBeDefined();
  expect(identityRow(root, "Admin")?.querySelector(".identity-open")?.textContent).toBe("Open");
  expect(inRow(root, "Admin", "Delete")).toBeUndefined();
  expect(inRow(root, "Admin", "Suspend")).toBeUndefined();
  expect(panelText(root)).not.toContain("Incognito workspace open");
  inRow(root, "Admin", "Close")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-suspend" }]);
  inRow(root, "Guest", "Switch to")?.click();
  await expect.poll(() => sent.at(-1)).toEqual({ type: "workspace-switch", identityId: "guest" });
});

test("another Incognito window disables every command but Delete and Close these windows", async () => {
  const { root } = mount({ ...SAVED, foreign: [{ id: 2, tabCount: 1 }] });
  await expect.poll(() => panelText(root)).toContain(CONFLICT);
  expect(enabledButtons(root)).toEqual(["Close these windows", "Delete", "Delete"]);
  expect(inRow(root, "Admin", "Switch to")?.disabled).toBe(true);
  expect(inPanel(root, "New identity")?.disabled).toBe(true);
});

test("a second tab in the managed window is a conflict too, with no window to close", async () => {
  const stray = { ...PRIVATE, id: 31, windowId: 3, title: "Stray" };
  const { root } = mount({ ...SAVED, managed: managedBy("admin") }, undefined, [SHOP, stray]);
  await expect.poll(() => panelText(root)).toContain(CONFLICT);
  expect(inRow(root, "Admin", "Close")?.disabled).toBe(true);
  expect(inRow(root, "Guest", "Switch to")?.disabled).toBe(true);
  expect(inPanel(root, "Close these windows")).toBeUndefined();
});

test("while an operation runs, the managed window's other tab is its helper, not a conflict", async () => {
  const helper = { ...PRIVATE, id: 31, windowId: 3, title: "" };
  const busy = { ...SAVED, managed: managedBy("admin"), busy: true };
  const { root, setStatus, incognito } = mount(busy, undefined, [SHOP, helper]);
  await expect.poll(() => inRow(root, "Admin", "Close")).toBeDefined();
  expect(panelText(root)).not.toContain(CONFLICT);
  // A tab still there once the operation ended is the user's.
  setStatus({ ...busy, busy: false });
  incognito.windowsChanged();
  await expect.poll(() => panelText(root)).toContain(CONFLICT);
});

test("without access, identities can still be deleted but none opens", async () => {
  const { root } = mount({ ...SAVED, access: false });
  await expect.poll(() => inRow(root, "Admin", "Delete")).toBeDefined();
  expect(inPanel(root, "New identity")).toBeUndefined();
  expect(inRow(root, "Admin", "Switch to")?.disabled).toBe(true);
  expect(inRow(root, "Admin", "Delete")?.disabled).toBe(false);
});

test("delete asks once more, and Keep takes it back", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inRow(root, "Guest", "Delete")).toBeDefined();
  inRow(root, "Guest", "Delete")?.click();
  await expect.poll(() => inRow(root, "Guest", "Keep")).toBeDefined();
  expect(identityRow(root, "Guest")?.textContent).toContain("removed from this computer");
  inRow(root, "Guest", "Keep")?.click();
  await expect.poll(() => inRow(root, "Guest", "Delete")).toBeDefined();
  inRow(root, "Guest", "Delete")?.click();
  await expect.poll(() => inRow(root, "Guest", "Delete Guest")).toBeDefined();
  inRow(root, "Guest", "Delete Guest")?.click();
  await expect
    .poll(() => sent)
    .toEqual([{ type: "workspace-delete-identity", identityId: "guest" }]);
});

test("a failed lifecycle command is an alert naming the command and its step", async () => {
  const operation = {
    id: "op-1",
    kind: "switch" as const,
    step: "capture",
    status: "failed" as const,
    started: 1,
    error: "The page did not open its link in time.",
  };
  const { root } = mount({ ...SAVED, operation });
  await expect
    .poll(() => alertText(root))
    .toEqual(["Switch to failed at the capture step. The page did not open its link in time."]);
});

test("a suspend that failed is named Close", async () => {
  const operation = {
    id: "op-3",
    kind: "suspend" as const,
    step: "close",
    status: "failed" as const,
    started: 1,
    error: "Gone.",
  };
  const { root } = mount({ ...SAVED, operation });
  await expect.poll(() => alertText(root)).toEqual(["Close failed at the close step. Gone."]);
});

test("a command's error that its failed operation already names shows once", async () => {
  const error = "The test build failed the restore step.";
  const operation = {
    id: "op-2",
    kind: "resume" as const,
    step: "restore",
    status: "failed" as const,
    started: 1,
    error,
  };
  const { root, setStatus } = mount(SAVED, (request) => {
    if (request.type !== "workspace-resume") return undefined;
    setStatus({ ...SAVED, operation });
    return Promise.resolve({ ok: false, error });
  });
  await expect.poll(() => inRow(root, "Admin", "Switch to")).toBeDefined();
  inRow(root, "Admin", "Switch to")?.click();
  await expect
    .poll(() => alertText(root))
    .toEqual([`Switch to failed at the restore step. ${error}`]);
});

test("a journaled failure from before stays hidden once the next command starts", async () => {
  const operation = {
    id: "op-4",
    kind: "switch" as const,
    step: "restore",
    status: "failed" as const,
    started: 1,
    error: "Old.",
  };
  let finish = (_reply: unknown) => {};
  const { root } = mount({ ...SAVED, operation }, (request) =>
    request.type === "workspace-switch" ? new Promise((resolve) => (finish = resolve)) : undefined,
  );
  await expect.poll(() => alertText(root)).toEqual(["Switch to failed at the restore step. Old."]);
  inRow(root, "Guest", "Switch to")?.click();
  await expect.poll(() => alertText(root)).toEqual([]);
  finish({ ok: true });
  await expect.poll(() => inRow(root, "Guest", "Switch to")?.disabled).toBe(false);
  expect(alertText(root)).toEqual([]);
});
