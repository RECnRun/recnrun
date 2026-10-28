import type { Identity } from "@recnrun/domain";
import { expect, test } from "vite-plus/test";
import { approximateSize } from "@/dashboard/Identities";
import { NO_INCOGNITO_WINDOW } from "./fake-extension";
import { PRIVATE, SHOP } from "./fake-tabs";
import { button } from "./queries";
import { inPanel, mount, panel, panelText, typeAddress } from "./workspace-panel";

const AT = Date.UTC(2026, 9, 28, 12, 30);
const ADMIN: Identity = {
  id: "admin",
  label: "Admin",
  url: "https://app.example/",
  capabilities: { cookieHosts: [] },
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

test("with nothing open, a saved identity resumes and one never saved opens empty", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inRow(root, "Admin", "Resume")).toBeDefined();
  inRow(root, "Admin", "Resume")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-resume", identityId: "admin" }]);
  inRow(root, "Guest", "Switch to")?.click();
  await expect.poll(() => sent.at(-1)).toEqual({ type: "workspace-switch", identityId: "guest" });
});

test("the open identity is named, suspends, and cannot be deleted; others switch", async () => {
  const { root, sent } = mount({ ...SAVED, managed: managedBy("admin") });
  await expect.poll(() => panelText(root)).toContain("Incognito workspace open: Admin");
  expect(identityRow(root, "Admin")?.textContent).toContain("Open");
  expect(inRow(root, "Admin", "Delete")).toBeUndefined();
  expect(inPanel(root, "Close and start empty")).toBeUndefined();
  inRow(root, "Admin", "Suspend")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-suspend" }]);
  inRow(root, "Guest", "Switch to")?.click();
  await expect.poll(() => sent.at(-1)).toEqual({ type: "workspace-switch", identityId: "guest" });
});

test("a workspace opened without an identity offers no switch, only Close and start empty", async () => {
  const { root } = mount({ ...SAVED, managed: managedBy() });
  await expect.poll(() => inPanel(root, "Close and start empty")).toBeDefined();
  expect(inRow(root, "Guest", "Switch to")).toBeUndefined();
  expect(inRow(root, "Admin", "Resume")).toBeUndefined();
  expect(inRow(root, "Guest", "Delete")).toBeDefined();
});

test("another Incognito window disables switching until it closes, but not Delete", async () => {
  const { root } = mount({ ...SAVED, foreign: [{ id: 2, tabCount: 1 }] });
  await expect.poll(() => panelText(root)).toContain(CONFLICT);
  expect(inRow(root, "Admin", "Resume")?.disabled).toBe(true);
  expect(inPanel(root, "New identity")?.disabled).toBe(true);
  expect(inRow(root, "Admin", "Delete")?.disabled).toBe(false);
});

test("a second tab in the managed window is a conflict too", async () => {
  const stray = { ...PRIVATE, id: 31, windowId: 3, title: "Stray" };
  const { root } = mount({ ...SAVED, managed: managedBy("admin") }, undefined, [SHOP, stray]);
  await expect.poll(() => panelText(root)).toContain(CONFLICT);
  expect(inRow(root, "Admin", "Suspend")?.disabled).toBe(true);
  expect(inRow(root, "Guest", "Switch to")?.disabled).toBe(true);
});

test("new identity sends its label and the address, with no extra cookie hosts", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  await typeAddress(root, "https://app.example/login");
  const label = panel(root)?.querySelectorAll("input")[1];
  if (!label) throw new Error("No label field");
  label.value = "Reviewer";
  label.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => label.value).toBe("Reviewer");
  inPanel(root, "New identity")?.click();
  await expect
    .poll(() => sent)
    .toEqual([
      {
        type: "workspace-new-identity",
        label: "Reviewer",
        url: "https://app.example/login",
        capabilities: { cookieHosts: [] },
      },
    ]);
});

/** Types into the panel field labelled `name` and waits until it holds the value. */
async function fill(root: HTMLElement, name: string, value: string) {
  const field = [...(panel(root)?.querySelectorAll("label") ?? [])]
    .find((label) => label.textContent.startsWith(name))
    ?.querySelector("input");
  if (!field) throw new Error(`No ${name} field`);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => field.value).toBe(value);
}

test("new identity sends the cookie hosts it declares, lowercased, once each", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  await typeAddress(root, "https://app.example/");
  await fill(root, "Label", "Reviewer");
  await fill(root, "Cookie hosts", " SSO.example.com,  login.example.com sso.example.com ");
  inPanel(root, "New identity")?.click();
  await expect.poll(() => sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    capabilities: { cookieHosts: ["sso.example.com", "login.example.com"] },
  });
});

test("a cookie host that is no host name is named, and New identity waits for a fix", async () => {
  const { root, sent } = mount(SAVED);
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  await fill(root, "Cookie hosts", "https://sso.example.com/");
  await expect
    .poll(() => panelText(root))
    .toContain("Cookie hosts are host names, such as sso.example.com.");
  expect(inPanel(root, "New identity")?.disabled).toBe(true);
  await fill(root, "Cookie hosts", "sso.example.com");
  await expect.poll(() => inPanel(root, "New identity")?.disabled).toBe(false);
  expect(sent).toEqual([]);
});

test("a saved identity names the cookie hosts it keeps besides its address", async () => {
  const sso = { ...GUEST, capabilities: { cookieHosts: ["sso.example.com", "login.example.com"] } };
  const { root } = mount({ ...SAVED, identities: [ADMIN, sso] });
  await expect.poll(() => identityRow(root, "Guest")).toBeDefined();
  expect(identityRow(root, "Guest")?.textContent).toContain(
    "Also keeps cookies of sso.example.com, login.example.com",
  );
  expect(identityRow(root, "Admin")?.textContent).not.toContain("Also keeps cookies");
});

test("without access, identities can still be deleted but no new one opens", async () => {
  const { root } = mount({ ...SAVED, access: false });
  await expect.poll(() => inRow(root, "Admin", "Delete")).toBeDefined();
  expect(inPanel(root, "New identity")).toBeUndefined();
  expect(inRow(root, "Admin", "Resume")?.disabled).toBe(true);
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
    .poll(() => panel(root)?.querySelector('[role="alert"]')?.textContent)
    .toBe("Switch failed at the capture step. The page did not open its link in time.");
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
  await expect.poll(() => inRow(root, "Admin", "Resume")).toBeDefined();
  inRow(root, "Admin", "Resume")?.click();
  const alerts = () =>
    [...(panel(root)?.querySelectorAll('[role="alert"]') ?? [])].map((each) => each.textContent);
  await expect.poll(alerts).toEqual([`Resume failed at the restore step. ${error}`]);
});
