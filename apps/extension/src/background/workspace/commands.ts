import { classifyIncognitoWindows, isAllowedTarget } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { closeWindows, createNeutralWindow, inventory } from "@/background/workspace/windows";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import { managedWindowRepository } from "@/storage/managed-window-repository";

/** What the dashboard can ask of the Incognito workspace. */
export interface WorkspaceCommands {
  status: () => Promise<WorkspaceStatus>;
  start: (url: string) => Promise<void>;
  closeAndStart: (url: string, windowIds: readonly number[]) => Promise<void>;
  restart: (url: string) => Promise<void>;
}

async function classifiedWindows() {
  const stored = (await managedWindowRepository.read()) ?? undefined;
  return { stored, ...classifyIncognitoWindows(await inventory(), stored) };
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
  const { foreign } = await classifiedWindows();
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

/** Discards the managed window's Incognito data by replacing the window; other windows would keep it. */
async function replaceManaged(url: string): Promise<void> {
  await requireAccess();
  const { managed, foreign } = await classifiedWindows();
  if (foreign.length > 0) {
    throw new WorkspaceError("IncognitoWindowsOpen", "Close the other Incognito windows first.");
  }
  if (managed === undefined) {
    throw new WorkspaceError("NoManagedWindow", "No Incognito workspace is open; start one first.");
  }
  await closeWindows([managed.id]);
  await startAt(url);
}

/** Closing an Incognito window could end the recorded tab; following it across windows is undecided (OD-2). */
async function requireNoRecording(recordings: RecordingStore): Promise<void> {
  if ((await recordings.read()) !== null) {
    throw new WorkspaceError("RecordingInProgress", "Stop the recording first.");
  }
}

/** One operation at a time, held in memory; a second one is refused rather than queued. */
export function createWorkspaceCommands(recordings: RecordingStore): WorkspaceCommands {
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
      const { stored, foreign } = await classifiedWindows();
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
      await exclusive(async () => {
        await requireNoRecording(recordings);
        await closeShownAndStart(url, windowIds);
      });
    },
    restart: async (url) => {
      requireTarget(url);
      await exclusive(async () => {
        await requireNoRecording(recordings);
        await replaceManaged(url);
      });
    },
  };
}
