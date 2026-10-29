import type {
  Identity,
  IdentityData,
  LifecycleCommand,
  LifecycleStep,
  ManagedWindowState,
  SkippedOrigin,
} from "@recnrun/domain";
import type { StepTiming } from "@/background/workspace/bootstrap";
import type { CaptureSummary } from "@/background/workspace/capture";
import type { IdentityDraft } from "@/background/workspace/identity-draft";
import type { IdentityRepository } from "@/ports/identities";
import type { OperationJournal } from "@/ports/operation-journal";
import type { RecordingStore } from "@/ports/recording-store";

export type LifecycleKind = LifecycleCommand["kind"];

/** Where a start opens and what it restores there: the saved capture's, or nothing. */
export interface Opening {
  from: "capture" | "empty";
  url: string;
  data: IdentityData;
}

/** What a start did: how long each step took, and the visited origins it could not restore. */
interface Started {
  timings: StepTiming[];
  skipped: SkippedOrigin[];
}

/** Chrome's side of each lifecycle step; tests replace it with fakes. */
export interface LifecycleEffects {
  /** The managed window while still open, every other Incognito window, and its other tabs. */
  windows: () => Promise<{
    managed?: ManagedWindowState;
    foreign: readonly number[];
    otherTabs: number;
  }>;
  /** Saves the open identity; `operationId` names the barriers its helper tab installs. */
  capture: (
    identity: Identity,
    managed: ManagedWindowState,
    operationId: string,
  ) => Promise<CaptureSummary>;
  close: (windowIds: readonly number[]) => Promise<void>;
  /** Reads and validates what a start of `identity` restores, before any step runs. */
  load: (identity: Identity, from: Opening["from"]) => Promise<Opening>;
  /** Opens a fresh managed window for `identity`, journaling its steps under `operation`. */
  start: (
    identity: Identity,
    opening: Opening,
    operation: { id: string; kind: LifecycleKind },
  ) => Promise<Started>;
  removeCaptures: (identityId: string) => Promise<void>;
  /** Ends a tentative capture: kept when it is `committedId`, else the one before comes back. */
  settle: (identityId: string, committedId: string | undefined) => Promise<void>;
  /** Runs before each step; the test build delays or fails a step through it. */
  beforeStep?: (step: LifecycleStep) => Promise<void>;
}

export interface LifecycleDeps {
  recordings: RecordingStore;
  identities: IdentityRepository;
  journal: OperationJournal;
  effects: LifecycleEffects;
  /** The workspace's one-operation lock and the Incognito access check. */
  guard: {
    exclusive: <T>(run: () => Promise<T>) => Promise<T>;
    access: () => Promise<void>;
  };
  now?: () => number;
}

/** Switch to, Suspend, Resume, New identity, Close windows, and Delete, each under the lock. */
export interface LifecycleCommands {
  switchTo: (identityId: string) => Promise<StepTiming[]>;
  suspend: () => Promise<void>;
  resume: (identityId: string) => Promise<StepTiming[]>;
  newIdentity: (draft: IdentityDraft) => Promise<Identity>;
  /** Closes the other Incognito windows the user saw, without saving them; they must be all of them. */
  closeWindows: (windowIds: readonly number[]) => Promise<void>;
  deleteIdentity: (identityId: string) => Promise<void>;
}
