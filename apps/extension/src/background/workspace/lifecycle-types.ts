import type {
  Identity,
  IdentityData,
  LifecycleCommand,
  LifecycleStep,
  ManagedWindowState,
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
  /** The hosts the identity declares; the start may hand over to them. */
  cookieHosts: readonly string[];
  data: IdentityData;
}

/** Chrome's side of each lifecycle step; tests replace it with fakes. */
export interface LifecycleEffects {
  /** The managed window while still open, every other Incognito window, and its other tabs. */
  windows: () => Promise<{
    managed?: ManagedWindowState;
    foreign: readonly number[];
    otherTabs: number;
  }>;
  capture: (identity: Identity, managed: ManagedWindowState) => Promise<CaptureSummary>;
  close: (windowIds: readonly number[]) => Promise<void>;
  /** Reads and validates what a start of `identity` restores, before any step runs. */
  load: (identity: Identity, from: Opening["from"]) => Promise<Opening>;
  /** Opens a fresh managed window for `identity`, journaling its steps under `operation`. */
  start: (
    identity: Identity,
    opening: Opening,
    operation: { id: string; kind: LifecycleKind },
  ) => Promise<StepTiming[]>;
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
  /** The workspace's one-operation lock, the Incognito access check, and the cookie hosts check. */
  guard: {
    exclusive: <T>(run: () => Promise<T>) => Promise<T>;
    access: () => Promise<void>;
    hosts: (cookieHosts: readonly string[]) => Promise<void>;
  };
  now?: () => number;
}

/** Switch to, Suspend, Resume, New identity, and Delete, each one operation under the lock. */
export interface LifecycleCommands {
  switchTo: (identityId: string) => Promise<StepTiming[]>;
  suspend: () => Promise<void>;
  resume: (identityId: string) => Promise<StepTiming[]>;
  /** Closes `closeWindowIds` without saving them first when given; they must be every other window. */
  newIdentity: (draft: IdentityDraft, closeWindowIds?: readonly number[]) => Promise<Identity>;
  deleteIdentity: (identityId: string) => Promise<void>;
}
