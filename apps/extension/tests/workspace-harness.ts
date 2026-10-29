import * as v from "valibot";
import { vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import type { IdentityDeps } from "@/background/workspace/identity-commands";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import { fakeBarrierApi } from "./fake-barrier";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";
import type { FakeCookieApi } from "./fake-cookies";
import { memoryRecordingStore } from "./fake-extension";
import { fakeHelperTabs, memoryVisits } from "./fake-helper";
import { fakeLayoutApi } from "./fake-layout";
import { fakeNavigationApi } from "./fake-navigation";

const EXTENSION_URL = "chrome-extension://own-id/";
const identity = { extensionId: "own-id", extensionUrl: EXTENSION_URL };
const ownPage = { id: "own-id", url: `${EXTENSION_URL}dashboard.html` };
export const contentScript = { id: "own-id", url: "https://recnrun.com/" };
export const TARGET = "https://app.example/";

export type Send = (message: unknown, sender?: object) => Promise<unknown>;

/** Chrome behind fakes: by default only the normal store is listed and no Incognito profile lives. */
export function fakeWorkspacePorts(
  cookies: FakeCookieApi = fakeCookieApi([[{ id: "0", tabIds: [1] }]], [1]),
  stores = memoryStoreMemory(),
) {
  const hooks = { beforeStep: async () => {} };
  return {
    cookies,
    stores,
    navigation: fakeNavigationApi(),
    barrier: fakeBarrierApi(),
    helperTabs: fakeHelperTabs(),
    layout: fakeLayoutApi(),
    visits: memoryVisits(),
    hooks,
  };
}

/** Delivers messages to one background, as Chrome would, and resolves with the validated reply. */
export function workspaceBackground(
  store: RecordingStore = memoryRecordingStore(),
  ports = fakeWorkspacePorts(),
  identities?: IdentityDeps,
): Send {
  const workspace = createWorkspaceCommands(store, ports, undefined, identities);
  const routes = createRoutes({ extensionVersion: "0.1.0", store, workspace });
  const listener = createBackgroundListener(routes, identity);
  return (message, sender = ownPage) =>
    new Promise<unknown>((resolve, reject) => {
      const answered = listener(message, sender as never, (reply) =>
        resolve(v.parse(BackgroundReplySchema, reply)),
      );
      if (!answered) reject(new Error("No answer"));
    });
}

const incognitoTabs = new Set<number>();

/** Has Chrome report `tabId` as an Incognito tab, which the fake browser never does. */
function markIncognito(tabId: number) {
  // One spy serves every marked tab; a second spy over the first would call itself.
  if (!vi.isMockFunction(fakeBrowser.tabs.get)) {
    incognitoTabs.clear();
    const get = fakeBrowser.tabs.get.bind(fakeBrowser.tabs);
    vi.spyOn(fakeBrowser.tabs, "get").mockImplementation((async (id: number) => {
      // The fake browser resolves nothing for an unknown id, though the type says otherwise.
      const tab = (await get(id)) as Browser.tabs.Tab | undefined;
      return tab && incognitoTabs.has(id) ? { ...tab, incognito: true } : tab;
    }) as never);
  }
  incognitoTabs.add(tabId);
}

/** Stores `tabId` as the open session's first tab, an Incognito one; `vi.restoreAllMocks()` ends that. */
export function manageTab(tabId: number, windowId = 1) {
  markIncognito(tabId);
  return managedWindowRepository.update(() => ({
    generation: 1,
    windowId,
    tabId,
    status: "active",
  }));
}

export const RECORDING_FIRST = { ok: false, error: "Stop the recording first." };

/** Chrome's "Allow in Incognito" toggle; the spy takes the callback overload's type. */
/** The user's grants in chrome://extensions: "Allow in Incognito", and Site access on all sites. */
export function allowIncognito(allowed: boolean) {
  vi.spyOn(fakeBrowser.extension, "isAllowedIncognitoAccess").mockResolvedValue(allowed as never);
  grantSiteAccess(true);
}

/** Site access "On all sites" (`true`), or withheld by "On click" or "On specific sites". */
export function grantSiteAccess(granted: boolean) {
  return vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(granted as never);
}

export async function readStatus(send: Send) {
  const reply = v.parse(BackgroundReplySchema, await send({ type: "workspace-status" }));
  if (!reply.ok) throw new Error(reply.error);
  return v.parse(WorkspaceStatusSchema, reply.result);
}

export const busyReply = {
  ok: false,
  error: "RECnRun is busy with another Incognito workspace operation.",
};

/** Holds the next tabs.update until the returned function runs, so an operation stays in flight. */
export function holdNextNavigation(): () => void {
  let finish = () => {};
  const navigation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(fakeBrowser.tabs, "update").mockReturnValueOnce(navigation as never);
  return finish;
}
