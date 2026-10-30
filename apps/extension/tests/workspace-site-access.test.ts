import type { IdentityData } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { hasSiteAccess } from "@/background/workspace/site-access";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { chrome, memoryCaptures } from "./fake-capture";
import { memoryRecordingStore } from "./fake-extension";
import { identity, memoryIdentities } from "./fake-lifecycle";
import { openWindowsWithTabs } from "./fake-windows";
import { allowIncognito, fakeWorkspacePorts, grantSiteAccess, TARGET } from "./workspace-harness";

const WITHHELD =
  "Set RECnRun's Site access to “On all sites” in its details in chrome://extensions, so it can save every site's cookies.";
const EMPTY: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
  origins: [],
};

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
  vi.restoreAllMocks();
});

test("site access asks Chrome for every http and https host", async () => {
  const contains = grantSiteAccess(true);
  expect(await hasSiteAccess()).toBe(true);
  expect(contains).toHaveBeenCalledWith({ origins: ["http://*/*", "https://*/*"] });
  grantSiteAccess(false);
  expect(await hasSiteAccess()).toBe(false);
});

test("the status says whether the user left RECnRun on all sites", async () => {
  expect(await commands().workspace.status()).toMatchObject({ siteAccess: true });
  grantSiteAccess(false);
  expect(await commands().workspace.status()).toMatchObject({ siteAccess: false, access: true });
});

test("with site access withheld every command that opens a window is refused before acting", async () => {
  grantSiteAccess(false);
  const { workspace, captures, memory } = commands();
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  const draft = { label: "Admin", url: TARGET };
  // One at a time: the workspace refuses a second operation while one runs.
  const attempts = [
    () => workspace.start(TARGET),
    () => workspace.closeAndStart(TARGET, []),
    () => workspace.restart(TARGET),
    () => workspace.startWithIdentity(TARGET, EMPTY),
    () => workspace.startFromCapture("a"),
    () => workspace.captureIdentity("a"),
    () => workspace.switchTo("a"),
    () => workspace.resume("a"),
    () => workspace.suspend(),
    () => workspace.newIdentity(draft),
  ];
  for (const attempt of attempts) await expect(attempt()).rejects.toThrow(WITHHELD);
  expect(fakeBrowser.windows.create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(captures.calls).toEqual([]);
  expect(memory.saved.map(({ id }) => id)).toEqual(["a"]);
});
