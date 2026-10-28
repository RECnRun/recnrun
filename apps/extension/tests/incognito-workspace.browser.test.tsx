import { expect, test } from "vite-plus/test";
import type { PageRequest } from "@/views/extension-services";
import { NO_INCOGNITO_WINDOW } from "./fake-extension";
import { identity } from "./fake-lifecycle";
import { SHOP } from "./fake-tabs";
import { button } from "./queries";
import { inPanel, mount, panel, panelText, row, typeAddress } from "./workspace-panel";

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

test("without access, the panel states the requirement and offers no Start", async () => {
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, access: false });
  await expect
    .poll(() => panelText(root))
    .toContain("The Incognito workspace requires “Allow in Incognito”.");
  expect(root.textContent).toContain("Enable Incognito Mode");
  expect(inPanel(root, "Start")).toBeUndefined();
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

test("with no Incognito window, Start opens the workspace at the address, then reads again", async () => {
  const { root, sent, reads } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  await typeAddress(root, TARGET);
  const before = reads();
  inPanel(root, "Start")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-start", url: TARGET }]);
  await expect.poll(() => reads()).toBeGreaterThan(before);
});

test("open Incognito windows are listed, and closing them sends exactly the ids shown", async () => {
  const { root, sent } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2, 5) });
  await expect.poll(() => panelText(root)).toContain("2 Incognito windows are open");
  const items = [...(panel(root)?.querySelectorAll("li") ?? [])].map((each) => each.textContent);
  expect(items).toEqual(["1 tab: Private", "3 tabs"]);
  expect(panelText(root)).toContain("close them yourself");
  expect(inPanel(root, "Start")).toBeUndefined();
  await typeAddress(root, TARGET);
  inPanel(root, "Close these windows and start")?.click();
  await expect
    .poll(() => sent)
    .toEqual([{ type: "workspace-close-and-start", url: TARGET, windowIds: [2, 5] }]);
});

test("one open Incognito window reads in the singular", async () => {
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(5) });
  await expect.poll(() => panelText(root)).toContain("1 Incognito window is open");
});

test("a windows-changed refusal shows the error and the new list, which the next try sends", async () => {
  const attempts: PageRequest[] = [];
  const { root, setStatus } = mount({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2) }, (request) => {
    if (request.type !== "workspace-close-and-start") return undefined;
    attempts.push(request);
    setStatus({ ...NO_INCOGNITO_WINDOW, foreign: foreign(2, 6) });
    return Promise.resolve({ ok: false, error: CHANGED });
  });
  await expect.poll(() => inPanel(root, "Close these windows and start")).toBeDefined();
  await typeAddress(root, TARGET);
  inPanel(root, "Close these windows and start")?.click();
  await expect.poll(() => panel(root)?.querySelector('[role="alert"]')?.textContent).toBe(CHANGED);
  await expect.poll(() => panelText(root)).toContain("2 Incognito windows are open");
  inPanel(root, "Close these windows and start")?.click();
  await expect
    .poll(() => attempts.map((each) => "windowIds" in each && each.windowIds))
    .toEqual([[2], [2, 6]]);
});

test("a window opening or closing reads the status again", async () => {
  const { root, setStatus, incognito } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  setStatus({ ...NO_INCOGNITO_WINDOW, foreign: foreign(4) });
  incognito.windowsChanged();
  await expect.poll(() => panelText(root)).toContain("1 Incognito window is open");
});

test("with the workspace open, Close and start empty restarts it and warns about its data", async () => {
  const managed = { generation: 1, windowId: 3, tabId: 30, status: "active" as const };
  const { root, sent } = mount({ ...NO_INCOGNITO_WINDOW, managed });
  await expect.poll(() => panelText(root)).toContain("Incognito workspace open");
  expect(panelText(root)).toContain("Its current Incognito data is discarded.");
  expect(inPanel(root, "Start")).toBeUndefined();
  await typeAddress(root, TARGET);
  inPanel(root, "Close and start empty")?.click();
  await expect.poll(() => sent).toEqual([{ type: "workspace-restart", url: TARGET }]);
});

test("with the workspace and other windows open, the panel lists them and offers no command", async () => {
  const managed = { generation: 1, windowId: 3, tabId: 30, status: "active" as const };
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, managed, foreign: foreign(5) });
  await expect.poll(() => panelText(root)).toContain("1 Incognito window is open");
  expect(panelText(root)).toContain("Incognito workspace open");
  expect(panelText(root)).toContain("Close the other Incognito windows yourself");
  for (const name of ["Close and start empty", "Close these windows and start", "Start"]) {
    expect(inPanel(root, name)).toBeUndefined();
  }
});

test("a closed managed window offers Start again", async () => {
  const managed = { generation: 1, windowId: 3, tabId: 30, status: "closed" as const };
  const { root } = mount({ ...NO_INCOGNITO_WINDOW, managed });
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  expect(panelText(root)).not.toContain("Incognito workspace open");
});

test("buttons wait while a command is in flight, and while the background is busy", async () => {
  let finish = (_reply: unknown) => {};
  const { root, setStatus, incognito } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-start" ? new Promise((resolve) => (finish = resolve)) : undefined,
  );
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  inPanel(root, "Start")?.click();
  await expect.poll(() => inPanel(root, "Start")?.disabled).toBe(true);
  finish({ ok: true });
  await expect.poll(() => inPanel(root, "Start")?.disabled).toBe(false);
  setStatus({ ...NO_INCOGNITO_WINDOW, busy: true });
  incognito.windowsChanged();
  await expect.poll(() => inPanel(root, "Start")?.disabled).toBe(true);
});

test("a refused command shows the background's error", async () => {
  const error = "Only http and https pages can open in the Incognito workspace.";
  const { root } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-start" ? Promise.resolve({ ok: false, error }) : undefined,
  );
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  inPanel(root, "Start")?.click();
  await expect.poll(() => panel(root)?.querySelector('[role="alert"]')?.textContent).toBe(error);
});

test("a status the background cannot read is an alert in the panel", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW, (request) =>
    request.type === "workspace-status"
      ? Promise.resolve({ ok: false, error: "Stored state is invalid" })
      : undefined,
  );
  await expect
    .poll(() => panel(root)?.querySelector('[role="alert"]')?.textContent)
    .toBe("Stored state is invalid");
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
  await expect.poll(() => inPanel(root, "Start")).toBeDefined();
  expect(panel(root)?.querySelector('[role="alert"]')).toBeNull();
  const error = "Interrupted: RECnRun restarted before the start finished.";
  const failed = { ...operation, status: "failed" as const, error };
  setStatus({ ...NO_INCOGNITO_WINDOW, operation: failed });
  // No window or tab changes: the journal's change alone must bring the failure in.
  await operations.write(failed);
  await expect
    .poll(() => panel(root)?.querySelector('[role="alert"]')?.textContent)
    .toBe(`Start with an identity failed at the restore step. ${error}`);
});

test("Use this tab's address fills the address from normal tabs only, without their data", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW);
  await expect.poll(() => button(row(root, "Shop"), "Use this tab's address")).toBeDefined();
  expect(button(row(root, "Private"), "Use this tab's address")).toBeUndefined();
  expect(panelText(root)).toContain("never its cookies or storage");
  button(row(root, "Shop"), "Use this tab's address")?.click();
  await expect.poll(() => panel(root)?.querySelector("input")?.value).toBe(SHOP.url);
});
