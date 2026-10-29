import { expect, test } from "vite-plus/test";
import type { PageRequest } from "@/views/extension-services";
import { NO_INCOGNITO_WINDOW } from "./fake-extension";
import { identity } from "./fake-lifecycle";
import { SHOP } from "./fake-tabs";
import { button } from "./queries";
import {
  alertText,
  enabledButtons,
  inPanel,
  mount,
  panel,
  panelText,
  row,
  typeAddress,
} from "./workspace-panel";

const TARGET = "https://app.example/start";
const CHANGED = "The Incognito windows changed; review them again before closing them.";

const foreign = (...ids: number[]) => ids.map((id) => ({ id, tabCount: id === 5 ? 3 : 1 }));

test("the panel is a region named Incognito workspace", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW);
  await expect
    .poll(() => panel(root)?.querySelector("h3")?.textContent)
    .toBe("Incognito workspace");
  expect(button(root, "New incognito window")).toBeUndefined();
});

test("without access, the panel states the requirement and offers no New identity", async () => {
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, access: false });
  await expect
    .poll(() => panelText(root))
    .toContain("The Incognito workspace requires “Allow in Incognito”.");
  expect(root.textContent).toContain("Enable Incognito Mode");
  expect(inPanel(root, "New identity")).toBeUndefined();
  expect(panel(root)?.querySelector("input")).toBeNull();
  expect(button(root, "Use this tab's address")).toBeUndefined();
});

test("in a build without the workspace's APIs, the panel says so once and offers no command", async () => {
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, available: false, identities: [identity("a")] });
  await expect
    .poll(() => panelText(root))
    .toBe("Incognito workspaceThe Incognito workspace is not available in this build.");
  expect(panel(root)?.querySelectorAll("button, input")).toHaveLength(0);
  expect(button(root, "Use this tab's address")).toBeUndefined();
  expect(root.querySelector("aside h2")?.textContent).toBe("Tabs");
});

test("the panel offers only the address and New identity, which sends no label", async () => {
  const { root, sent, reads } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  expect(enabledButtons(root)).toEqual(["New identity"]);
  expect(panel(root)?.querySelectorAll("input")).toHaveLength(1);
  expect(panelText(root)).toContain("Saves the open identity first, then opens the address empty.");
  await typeAddress(root, TARGET);
  const before = reads();
  inPanel(root, "New identity")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-new-identity", url: TARGET }]);
  await expect.poll(() => reads()).toBeGreaterThan(before);
});

test("open Incognito windows are listed, and Close these windows sends exactly the ids shown", async () => {
  const { root, sent } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2, 5) });
  await expect.poll(() => panelText(root)).toContain("2 Incognito windows are open");
  const list = panel(root)?.querySelector("ul.incognito-windows");
  const items = [...(list?.querySelectorAll("li") ?? [])].map((each) => each.textContent);
  expect(items).toEqual(["1 tab: Private", "3 tabs"]);
  expect(enabledButtons(root)).toEqual(["Close these windows"]);
  inPanel(root, "Close these windows")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-close-windows", windowIds: [2, 5] }]);
});

test("one open Incognito window reads in the singular", async () => {
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(5) });
  await expect.poll(() => panelText(root)).toContain("1 Incognito window is open");
});

test("a windows-changed refusal shows the error and the new list, which the next try sends", async () => {
  const attempts: PageRequest[] = [];
  const { root, setStatus } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2) }, (request) => {
    if (request.type !== "workspace-close-windows") return undefined;
    attempts.push(request);
    setStatus({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2, 6) });
    return Promise.resolve({ ok: false, error: CHANGED });
  });
  await expect.poll(() => inPanel(root, "Close these windows")).toBeDefined();
  inPanel(root, "Close these windows")?.click();
  await expect.poll(() => alertText(root)).toEqual([`Close these windows failed. ${CHANGED}`]);
  await expect.poll(() => panelText(root)).toContain("2 Incognito windows are open");
  inPanel(root, "Close these windows")?.click();
  await expect
    .poll(() => attempts.map((each) => "windowIds" in each && each.windowIds))
    .toEqual([[2], [2, 6]]);
});

test("a window opening or closing reads the status again", async () => {
  const { root, setStatus, incognito } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  setStatus({ ...NO_INCOGNITO_WINDOW, foreign: foreign(4) });
  incognito.windowsChanged();
  await expect.poll(() => panelText(root)).toContain("1 Incognito window is open");
});

test("buttons wait while a command is in flight, and while the background is busy", async () => {
  let finish = (_reply: unknown) => {};
  const { root, setStatus, incognito } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-new-identity"
      ? new Promise((resolve) => (finish = resolve))
      : undefined,
  );
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  inPanel(root, "New identity")?.click();
  await expect.poll(() => inPanel(root, "New identity")?.disabled).toBe(true);
  finish({ ok: true });
  await expect.poll(() => inPanel(root, "New identity")?.disabled).toBe(false);
  setStatus({ ...NO_INCOGNITO_WINDOW, busy: true });
  incognito.windowsChanged();
  await expect.poll(() => inPanel(root, "New identity")?.disabled).toBe(true);
});

test("a refused command is one alert under the heading, naming the command", async () => {
  const error = "Only http and https pages can open in the Incognito workspace.";
  const { root } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-new-identity" ? Promise.resolve({ ok: false, error }) : undefined,
  );
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  inPanel(root, "New identity")?.click();
  await expect.poll(() => alertText(root)).toEqual([`New identity failed. ${error}`]);
  expect(panel(root)?.querySelector("h3 + [role='alert']")).not.toBeNull();
});

test("the alert clears when the next command starts", async () => {
  let reply: unknown = { ok: false, error: "Not now." };
  let finish = (_reply: unknown) => {};
  const { root } = mount(NO_INCOGNITO_WINDOW, (request) => {
    if (request.type !== "workspace-new-identity") return undefined;
    if (reply !== undefined) return Promise.resolve(reply);
    return new Promise((resolve) => (finish = resolve));
  });
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  inPanel(root, "New identity")?.click();
  await expect.poll(() => alertText(root)).toEqual(["New identity failed. Not now."]);
  reply = undefined;
  inPanel(root, "New identity")?.click();
  await expect.poll(() => alertText(root)).toEqual([]);
  finish({ ok: true });
});

test("a status the background cannot read is an alert in the panel", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-status"
      ? Promise.resolve({ ok: false, error: "Stored state is invalid" })
      : undefined,
  );
  await expect.poll(() => alertText(root)).toEqual(["Stored state is invalid"]);
});

test("a failed start with an identity is an alert naming its step as soon as it is journaled", async () => {
  const operation = {
    id: "op-1",
    kind: "start-with-identity" as const,
    step: "restore",
    status: "running" as const,
    started: 1,
  };
  const { root, setStatus, operations } = mount({ ...NO_INCOGNITO_WINDOW, busy: true, operation });
  await expect.poll(() => inPanel(root, "New identity")).toBeDefined();
  expect(alertText(root)).toEqual([]);
  const error = "Interrupted: RECnRun restarted before the start finished.";
  const failed = { ...operation, status: "failed" as const, error };
  setStatus({ ...NO_INCOGNITO_WINDOW, operation: failed });
  // No window or tab changes: the journal's change alone must bring the failure in.
  await operations.write(failed);
  await expect
    .poll(() => alertText(root))
    .toEqual([`Start with an identity failed at the restore step. ${error}`]);
});

test("Use this tab's address fills the address from normal tabs only, without their data", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => button(row(root, "Shop"), "Use this tab's address")).toBeDefined();
  expect(button(row(root, "Private"), "Use this tab's address")).toBeUndefined();
  expect(panelText(root)).toContain("never its cookies or storage");
  button(row(root, "Shop"), "Use this tab's address")?.click();
  await expect.poll(() => panel(root)?.querySelector("input")?.value).toBe(SHOP.url);
});
