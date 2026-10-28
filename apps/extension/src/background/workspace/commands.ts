import { classifyIncognitoWindows, isAllowedTarget } from "@recnrun/domain";
import type { CaptureCapabilities, IdentityData } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { chromeBarrierApi } from "@/background/workspace/barrier";
import { bootstrapIdentity } from "@/background/workspace/bootstrap";
import type { BootstrapHooks, BootstrapPorts, StepTiming } from "@/background/workspace/bootstrap";
import type { CaptureSummary } from "@/background/workspace/capture";
import { chromeCookieApi } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";
import {
  closeManagedRemembering,
  closeRemembering,
  openFreshWindow,
} from "@/background/workspace/fresh-window";
import {
  captureManaged,
  chromeIdentityDeps,
  savedStart,
} from "@/background/workspace/identity-commands";
import type { IdentityDeps } from "@/background/workspace/identity-commands";
import { createLifecycle } from "@/background/workspace/lifecycle";
import type { LifecycleCommands } from "@/background/workspace/lifecycle";
import { chromeLifecycleEffects } from "@/background/workspace/lifecycle-effects";
import { chromeNavigationApi } from "@/background/workspace/navigation";
import { recoverInterrupted } from "@/background/workspace/recovery";
import type { RecoveryDeps } from "@/background/workspace/recovery";
import { createNeutralWindow, inventory } from "@/background/workspace/windows";
import { incognitoStoreMemory } from "@/storage/incognito-stores";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { OperationJournal } from "@/ports/operation-journal";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { operationJournal } from "@/storage/operation-journal";

/** What the dashboard can ask of the Incognito workspace and its saved identities. */
export interface WorkspaceCommands extends LifecycleCommands {
  status: () => Promise<WorkspaceStatus>;
  start: (url: string) => Promise<void>;
  closeAndStart: (url: string, windowIds: readonly number[]) => Promise<void>;
  restart: (url: string) => Promise<void>;
  startWithIdentity: (url: string, data: IdentityData) => Promise<StepTiming[]>;
  /** Saves the managed tab's page and cookies as `identityId`'s data, widened by `capabilities`. */
  captureIdentity: (
    identityId: string,
    capabilities: CaptureCapabilities,
  ) => Promise<CaptureSummary>;
  /** Starts a fresh managed window from `identityId`'s published capture. */
  startFromCapture: (identityId: string) => Promise<StepTiming[]>;
  recover: () => Promise<void>;
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

/** Opens a fresh managed window, once Chrome destroyed the previous Incognito profile, at `url`. */
async function startAt(url: string, ports: BootstrapPorts): Promise<void> {
  await requireAccess();
  const { tabId } = await openFreshWindow(ports);
  await browser.tabs.update(tabId, { url });
}

/** The user decided on the windows they saw; any other set needs a fresh decision. */
async function closeShownAndStart(
  url: string,
  windowIds: readonly number[],
  ports: BootstrapPorts,
): Promise<void> {
  await requireAccess();
  const { managed, foreign } = await classifiedWindows();
  // Starting needs every Incognito window gone, so closing the shown ones first would be in vain.
  if (managed !== undefined) {
    throw new WorkspaceError(
      "WorkspaceOpen",
      "Close and start empty replaces the open workspace; close the other Incognito windows first.",
    );
  }
  const shown = new Set(windowIds);
  if (shown.size !== foreign.length || !foreign.every((window) => shown.has(window.id))) {
    throw new WorkspaceError(
      "WindowsChanged",
      "The Incognito windows changed; review them again before closing them.",
    );
  }
  await closeRemembering(windowIds, ports);
  await startAt(url, ports);
}

/** Discards the managed window's Incognito data by replacing the window; other windows would keep it. */
async function replaceManaged(url: string, ports: BootstrapPorts): Promise<void> {
  await requireAccess();
  const { managed, foreign } = await classifiedWindows();
  if (foreign.length > 0) {
    throw new WorkspaceError("IncognitoWindowsOpen", "Close the other Incognito windows first.");
  }
  if (managed === undefined) {
    throw new WorkspaceError("NoManagedWindow", "No Incognito workspace is open; start one first.");
  }
  await closeRemembering([managed.id], ports);
  await startAt(url, ports);
}

/** Closing an Incognito window could end the recorded tab; following it across windows is undecided (OD-2). */
async function requireNoRecording(recordings: RecordingStore): Promise<void> {
  if ((await recordings.read()) !== null) {
    throw new WorkspaceError("RecordingInProgress", "Stop the recording first.");
  }
}

/** The bootstrap's Chrome APIs; `hooks` lets a test build delay or fail a step. */
export function chromeBootstrapPorts(
  hooks: BootstrapHooks = { beforeStep: async () => {} },
): BootstrapPorts {
  return {
    cookies: chromeCookieApi,
    stores: incognitoStoreMemory,
    navigation: chromeNavigationApi,
    barrier: chromeBarrierApi,
    hooks,
  };
}

/**
 * One operation at a time, held in memory; a second one is refused rather than queued. Every
 * command and status read first waits for `ready`, the recovery of a start the last worker left.
 */
function createLock(journal: OperationJournal) {
  const lock = {
    busy: false,
    ready: Promise.resolve() as Promise<unknown>,
    exclusive: async <T>(run: () => Promise<T>): Promise<T> => {
      if (lock.busy) {
        throw new WorkspaceError(
          "WorkspaceBusy",
          "RECnRun is busy with another Incognito workspace operation.",
        );
      }
      lock.busy = true;
      try {
        await lock.ready;
        // The last start's outcome is shown until another command runs.
        await journal.clear();
        return await run();
      } finally {
        lock.busy = false;
      }
    },
  };
  return lock;
}

/** Starts the recovery and makes every later command and status read wait for it. */
function recoverInto(
  lock: ReturnType<typeof createLock>,
  deps: Omit<RecoveryDeps, "closeWindow">,
  ports: BootstrapPorts,
): Promise<void> {
  const closeWindow = (windowId: number, generation: number) =>
    closeManagedRemembering(windowId, generation, ports);
  const recovering = recoverInterrupted({ ...deps, closeWindow });
  // A failed recovery leaves the journal as it was; the status then shows it as it is.
  lock.ready = recovering.catch(() => undefined);
  return recovering.then(() => undefined);
}

type Exclusive = ReturnType<typeof createLock>["exclusive"];

async function statusOf(
  lock: ReturnType<typeof createLock>,
  journal: OperationJournal,
  identities: IdentityDeps["identities"],
): Promise<WorkspaceStatus> {
  await lock.ready;
  const access = await browser.extension.isAllowedIncognitoAccess();
  const { stored, foreign } = await classifiedWindows();
  const summaries = foreign.map(({ id, tabs }) => ({ id, tabCount: tabs?.length ?? 0 }));
  const operation = (await journal.read()) ?? undefined;
  const saved = await identities.list();
  const { busy } = lock;
  const status = { access, managed: stored, foreign: summaries, busy, identities: saved };
  return { ...status, ...(operation && { operation }) };
}

/** Opens a fresh managed window and restores what `load` yields, under the one-operation lock. */
function restoringStart(
  recordings: RecordingStore,
  ports: BootstrapPorts,
  journal: OperationJournal,
  exclusive: Exclusive,
) {
  const windows = {
    create: createNeutralWindow,
    close: (ids: readonly number[]) => closeRemembering(ids, ports),
  };
  return (load: () => Promise<{ url: string; data: IdentityData }>) =>
    exclusive(async () => {
      await requireNoRecording(recordings);
      await requireAccess();
      const { url, data } = await load();
      const deps = { ...ports, windows, record: journal.write };
      return bootstrapIdentity(url, data, deps, crypto.randomUUID());
    });
}

export function createWorkspaceCommands(
  recordings: RecordingStore,
  ports: BootstrapPorts = chromeBootstrapPorts(),
  journal: OperationJournal = operationJournal,
  identities: IdentityDeps = chromeIdentityDeps(),
): WorkspaceCommands {
  const lock = createLock(journal);
  const { exclusive } = lock;
  const startRestoring = restoringStart(recordings, ports, journal, exclusive);
  return {
    ...createLifecycle({
      recordings,
      identities: identities.identities,
      journal,
      effects: chromeLifecycleEffects(ports, identities, journal),
      guard: { exclusive, access: requireAccess },
    }),
    recover: () => recoverInto(lock, { journal, barrier: ports.barrier }, ports),
    status: () => statusOf(lock, journal, identities.identities),
    // Async, so a refused target rejects; the busy check still runs before the first await.
    start: async (url) => {
      requireTarget(url);
      await exclusive(() => startAt(url, ports));
    },
    closeAndStart: async (url, windowIds) => {
      requireTarget(url);
      await exclusive(async () => {
        await requireNoRecording(recordings);
        await closeShownAndStart(url, windowIds, ports);
      });
    },
    restart: async (url) => {
      requireTarget(url);
      await exclusive(async () => {
        await requireNoRecording(recordings);
        await replaceManaged(url, ports);
      });
    },
    startWithIdentity: async (url, data) => {
      requireTarget(url);
      return startRestoring(async () => ({ url, data }));
    },
    captureIdentity: (identityId, capabilities) =>
      exclusive(async () => {
        await requireAccess();
        return captureManaged(identityId, identities, capabilities);
      }),
    startFromCapture: (identityId) =>
      startRestoring(() => savedStart(identityId, identities.captures)),
  };
}
