import { classifyIncognitoWindows, isAllowedTarget } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { closeWindows, createNeutralWindow, inventory } from "@/background/workspace/windows";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import { managedWindowRepository } from "@/storage/managed-window-repository";

/** What the dashboard can ask of the Incognito workspace. */
export interface WorkspaceCommands {
  status: () => Promise<WorkspaceStatus>;
  start: (url: string) => Promise<void>;
  closeAndStart: (url: string, windowIds: readonly number[]) => Promise<void>;
}

async function foreignWindows() {
  const stored = (await managedWindowRepository.read()) ?? undefined;
  return { stored, foreign: classifyIncognitoWindows(await inventory(), stored).foreign };
}

function requireTarget(url: string): void {
  if (!isAllowedTarget(url)) {
    throw new WorkspaceError(
      "TargetNotAllowed",
      "Only http and https pages can open in the Incognito workspace.",
    );
  }
}

/** Without access, Chrome hides Incognito windows, so the inventory could not prove none is open. */
async function requireAccess(): Promise<void> {
  if (!(await browser.extension.isAllowedIncognitoAccess())) {
    throw new WorkspaceError("IncognitoNotAllowed", "Allow RECnRun in Incognito first.");
  }
}

async function startAt(url: string): Promise<void> {
  await requireAccess();
  const { tabId } = await createNeutralWindow();
  await browser.tabs.update(tabId, { url });
}

/** The user decided on the windows they saw; any other set needs a fresh decision. */
async function closeShownAndStart(url: string, windowIds: readonly number[]): Promise<void> {
  await requireAccess();
  const { foreign } = await foreignWindows();
  const shown = new Set(windowIds);
  if (shown.size !== foreign.length || !foreign.every((window) => shown.has(window.id))) {
    throw new WorkspaceError(
      "WindowsChanged",
      "The Incognito windows changed; review them again before closing them.",
    );
  }
  await closeWindows(windowIds);
  await startAt(url);
}

/** One operation at a time, held in memory; a second one is refused rather than queued. */
export function createWorkspaceCommands(): WorkspaceCommands {
  let busy = false;
  const exclusive = async (operation: () => Promise<void>) => {
    if (busy) {
      throw new WorkspaceError(
        "WorkspaceBusy",
        "RECnRun is busy with another Incognito workspace operation.",
      );
    }
    busy = true;
    try {
      await operation();
    } finally {
      busy = false;
    }
  };
  return {
    status: async () => {
      const access = await browser.extension.isAllowedIncognitoAccess();
      const { stored, foreign } = await foreignWindows();
      const summaries = foreign.map(({ id, tabs }) => ({ id, tabCount: tabs?.length ?? 0 }));
      return { access, managed: stored, foreign: summaries, busy };
    },
    // Async, so a refused target rejects; the busy check still runs before the first await.
    start: async (url) => {
      requireTarget(url);
      await exclusive(() => startAt(url));
    },
    closeAndStart: async (url, windowIds) => {
      requireTarget(url);
      await exclusive(() => closeShownAndStart(url, windowIds));
    },
  };
}
