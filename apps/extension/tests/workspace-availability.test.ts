import type { IdentityData } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { workspaceAvailable } from "@/background/workspace/availability";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { chrome, memoryCaptures } from "./fake-capture";
import { memoryRecordingStore } from "./fake-extension";
import { identity, memoryIdentities } from "./fake-lifecycle";
import { openWindowsWithTabs } from "./fake-windows";
import { allowIncognito, fakeWorkspacePorts, TARGET } from "./workspace-harness";

const APIS = ["cookies", "declarativeNetRequest", "scripting", "webNavigation"] as const;
const UNAVAILABLE =
  "This build of RECnRun cannot tell when Chrome has cleared an Incognito session.";
const EMPTY: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
};

const saved = { cookies: fakeBrowser.cookies };

/** A production build: Chrome exposes no `cookies` API without its permission. */
function withoutCookies() {
  Reflect.deleteProperty(fakeBrowser, "cookies");
}

function commands() {
  const { api, cookies } = chrome();
  const captures = memoryCaptures();
  const { memory, repository } = memoryIdentities([identity("a")]);
  const deps = { api, cookies, captures, identities: repository };
  const workspace = createWorkspaceCommands(
    memoryRecordingStore(),
    fakeWorkspacePorts(),
    undefined,
    deps,
  );
  return { workspace, captures, memory };
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  allowIncognito(true);
});

afterEach(() => {
  fakeBrowser.cookies = saved.cookies;
  vi.restoreAllMocks();
});

test("the workspace is available only when Chrome exposes every API it needs", () => {
  const all = Object.fromEntries(APIS.map((name) => [name, {}]));
  expect(workspaceAvailable(all)).toBe(true);
  for (const name of APIS) {
    const { [name]: _missing, ...rest } = all;
    expect(workspaceAvailable(rest)).toBe(false);
  }
});

test("the status says whether this build can run the workspace", async () => {
  expect(await commands().workspace.status()).toMatchObject({ available: true });
  withoutCookies();
  expect(await commands().workspace.status()).toMatchObject({ available: false, access: true });
});

test("without the cookies API every command that opens a window is refused before acting", async () => {
  withoutCookies();
  const { workspace, captures, memory } = commands();
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  const draft = { label: "Admin", url: TARGET, capabilities: { cookieHosts: [] } };
  // One at a time: the workspace refuses a second operation while one runs.
  const attempts = [
    () => workspace.start(TARGET),
    () => workspace.closeAndStart(TARGET, []),
    () => workspace.restart(TARGET),
    () => workspace.startWithIdentity(TARGET, EMPTY),
    () => workspace.startFromCapture("a"),
    () => workspace.captureIdentity("a", { cookieHosts: [] }),
    () => workspace.switchTo("a"),
    () => workspace.resume("a"),
    () => workspace.suspend(),
    () => workspace.newIdentity(draft),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toThrow(UNAVAILABLE);
  expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(captures.calls).toEqual([]);
  expect(memory.saved.map(({ id }) => id)).toEqual(["a"]);
});
