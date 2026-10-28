import { errorMessage, IdentitySchema, planLifecycle } from "@recnrun/domain";
import type {
  CaptureCapabilities,
  Identity,
  LifecycleCommand,
  LifecycleState,
  LifecycleStep,
  ManagedWindowState,
  WorkspaceOperation,
} from "@recnrun/domain";
import * as v from "valibot";
import type { StepTiming } from "@/background/workspace/bootstrap";
import type { CaptureSummary } from "@/background/workspace/capture";
import { WorkspaceError } from "@/background/workspace/errors";
import type { IdentityRepository } from "@/ports/identities";
import type { OperationJournal } from "@/ports/operation-journal";
import type { RecordingStore } from "@/ports/recording-store";

type LifecycleKind = LifecycleCommand["kind"];

/** Chrome's side of each lifecycle step; tests replace it with fakes. */
export interface LifecycleEffects {
  /** The managed window while its window is still open, and every other Incognito window. */
  windows: () => Promise<{ managed?: ManagedWindowState; foreign: readonly number[] }>;
  capture: (identity: Identity, managed: ManagedWindowState) => Promise<CaptureSummary>;
  close: (windowIds: readonly number[]) => Promise<void>;
  /** Opens a fresh managed window for `identity`, journaling its steps under `operation`. */
  start: (
    identity: Identity,
    from: "capture" | "empty",
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
  /** The workspace's one-operation lock and the Incognito access check. */
  guard: { exclusive: <T>(run: () => Promise<T>) => Promise<T>; access: () => Promise<void> };
  now?: () => number;
}

interface IdentityDraft {
  label: string;
  url: string;
  capabilities: CaptureCapabilities;
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

interface Run {
  deps: LifecycleDeps;
  kind: LifecycleKind;
  operation: WorkspaceOperation;
  /** The identity the open window holds, and the window, while one is open. */
  open?: { identity: Identity; managed: ManagedWindowState };
  target?: Identity;
  /** A new identity, saved only once the open one is saved and closed. */
  adding?: Identity;
  captured?: CaptureSummary;
  /** Set once the open identity names the new capture as its last one. */
  persisted?: boolean;
  timings: StepTiming[];
}

const START_STEPS: ReadonlySet<LifecycleStep> = new Set(["start-from-capture", "start-empty"]);
const HOLDING_STEPS: ReadonlySet<LifecycleStep> = new Set(["capture", "persist", "close"]);

/** Until it is closed, the open window is journaled, so a restart's recovery closes it. */
function journaled(run: Run, step: LifecycleStep): WorkspaceOperation {
  const managed = run.open?.managed;
  if (managed === undefined || !HOLDING_STEPS.has(step)) return run.operation;
  return { ...run.operation, generation: managed.generation, windowId: managed.windowId };
}

/** The window reads again: another Incognito window may have opened during the capture. */
async function closeOpen(run: Run): Promise<void> {
  const { managed, foreign } = await run.deps.effects.windows();
  if (foreign.length > 0) {
    const message = "The capture is saved; close the other Incognito windows first.";
    throw new WorkspaceError("IncognitoWindowsOpen", message);
  }
  if (managed !== undefined) await run.deps.effects.close([managed.windowId]);
}

async function persist(run: Run): Promise<void> {
  const { open, captured, deps } = run;
  if (open === undefined || captured === undefined) return;
  const lastCapture = {
    id: captured.captureId,
    at: (deps.now ?? Date.now)(),
    bytes: captured.bytes,
  };
  await deps.identities.update((list) =>
    list.map((each) => (each.id === open.identity.id ? { ...each, lastCapture } : each)),
  );
  run.persisted = true;
  // Reads settle first, so a failure here only leaves the replaced capture until then.
  await deps.effects.settle(open.identity.id, captured.captureId).catch(() => undefined);
}

/** A capture the identity does not name yet is taken back, so its last capture stays published. */
async function takeBack(run: Run): Promise<void> {
  const { open, captured, persisted, deps } = run;
  if (open === undefined || captured === undefined || persisted === true) return;
  const previous = open.identity.lastCapture?.id;
  // When this fails too, the next read or capture of the identity settles it the same way.
  await deps.effects.settle(open.identity.id, previous).catch(() => undefined);
}

async function start(run: Run, from: "capture" | "empty"): Promise<void> {
  const { target, adding, deps, kind } = run;
  if (target === undefined) return;
  if (adding) await deps.identities.update((current) => [...current, adding]);
  run.timings = await deps.effects.start(target, from, { id: run.operation.id, kind });
}

const STEP_RUNS: Record<LifecycleStep, (run: Run) => Promise<void>> = {
  capture: async (run) => {
    if (run.open)
      run.captured = await run.deps.effects.capture(run.open.identity, run.open.managed);
  },
  persist,
  close: closeOpen,
  "start-from-capture": (run) => start(run, "capture"),
  "start-empty": (run) => start(run, "empty"),
  remove: async (run) => {
    if (run.target === undefined) return;
    const { id } = run.target;
    await run.deps.effects.removeCaptures(id);
    await run.deps.identities.update((list) => list.filter((each) => each.id !== id));
  },
};

/** Records the failure at its step, unless the bootstrap already recorded it at its own step. */
async function recordFailure(run: Run, error: unknown): Promise<void> {
  const { journal } = run.deps;
  const current = await journal.read().catch(() => null);
  if (current?.id === run.operation.id && current.status === "failed") return;
  run.operation = { ...run.operation, status: "failed", error: errorMessage(error) };
  // A journal that cannot be written must not hide the failure from the caller.
  await journal.write(run.operation).catch(() => undefined);
}

/** Runs `steps` in order, journaling each; a start step's bootstrap journals its own steps. */
async function runSteps(run: Run, steps: readonly LifecycleStep[]): Promise<void> {
  for (const step of steps) {
    run.operation = { ...run.operation, step };
    await run.deps.journal.write(journaled(run, step));
    try {
      await run.deps.effects.beforeStep?.(step);
      await STEP_RUNS[step](run);
    } catch (error) {
      await takeBack(run);
      await recordFailure(run, error);
      throw error;
    }
  }
  const last = steps.at(-1);
  if (last === undefined || START_STEPS.has(last)) return;
  run.operation = { ...run.operation, status: "done" };
  await run.deps.journal.write(run.operation);
}

/** What the plan decides on, read fresh under the lock. */
async function readState(deps: LifecycleDeps, adding: Identity | undefined) {
  const list = [...(await deps.identities.list()), ...(adding ? [adding] : [])];
  const { managed, foreign } = await deps.effects.windows();
  const state: LifecycleState = {
    recording: (await deps.recordings.read()) !== null,
    foreignWindows: foreign.length,
    open: managed && (managed.identityId === undefined ? {} : { identityId: managed.identityId }),
    identities: list.map(({ id, lastCapture }) => ({ id, captured: lastCapture !== undefined })),
  };
  return { list, managed, state };
}

/** The open window and its saved identity; a window whose identity was deleted cannot be saved. */
function openOf(list: readonly Identity[], managed: ManagedWindowState | undefined): Run["open"] {
  if (managed?.identityId === undefined) return undefined;
  const identity = list.find(({ id }) => id === managed.identityId);
  if (identity === undefined) {
    throw new WorkspaceError(
      "IdentityNotFound",
      "The open workspace's identity is no longer saved.",
    );
  }
  return { identity, managed };
}

/** Plans `command` on a fresh read, then runs its steps. */
async function execute(
  deps: LifecycleDeps,
  command: LifecycleCommand,
  adding?: Identity,
): Promise<StepTiming[]> {
  const { list, managed, state } = await readState(deps, adding);
  const plan = planLifecycle(command, state);
  if (!plan.ok) throw new WorkspaceError(plan.refusal.name, plan.refusal.message);
  const run: Run = {
    deps,
    kind: command.kind,
    operation: operationFor(command, deps),
    open: plan.steps.includes("capture") ? openOf(list, managed) : undefined,
    target: list.find(({ id }) => "identityId" in command && id === command.identityId),
    ...(adding && { adding }),
    timings: [],
  };
  await runSteps(run, plan.steps);
  return run.timings;
}

function operationFor(command: LifecycleCommand, deps: LifecycleDeps): WorkspaceOperation {
  return {
    id: crypto.randomUUID(),
    kind: command.kind,
    step: "plan",
    status: "running",
    started: (deps.now ?? Date.now)(),
  };
}

function validIdentity(draft: IdentityDraft, created: number): Identity {
  const parsed = v.safeParse(IdentitySchema, { id: crypto.randomUUID(), created, ...draft });
  if (!parsed.success) {
    const message = "Give the identity a label and an http or https address.";
    throw new WorkspaceError("IdentityNotValid", message);
  }
  return parsed.output;
}

/** The user decided on the windows they saw; any other set needs a fresh decision. */
async function closeShown(deps: LifecycleDeps, windowIds: readonly number[]): Promise<void> {
  const { foreign } = await deps.effects.windows();
  const shown = new Set(windowIds);
  if (shown.size !== foreign.length || !foreign.every((id) => shown.has(id))) {
    const message = "The Incognito windows changed; review them again before closing them.";
    throw new WorkspaceError("WindowsChanged", message);
  }
  if ((await deps.recordings.read()) !== null) {
    throw new WorkspaceError("RecordingInProgress", "Stop the recording first.");
  }
  // Windows RECnRun did not open belong to no identity, so their data is discarded, as shown.
  await deps.effects.close(windowIds);
}

export function createLifecycle(deps: LifecycleDeps): LifecycleCommands {
  const { exclusive, access } = deps.guard;
  const opening = (command: LifecycleCommand) =>
    exclusive(async () => {
      await access();
      return execute(deps, command);
    });
  return {
    switchTo: (identityId) => opening({ kind: "switch", identityId }),
    resume: (identityId) => opening({ kind: "resume", identityId }),
    suspend: async () => {
      await opening({ kind: "suspend" });
    },
    newIdentity: (draft, closeWindowIds) =>
      exclusive(async () => {
        const identity = validIdentity(draft, (deps.now ?? Date.now)());
        await access();
        if (closeWindowIds !== undefined) await closeShown(deps, closeWindowIds);
        await execute(deps, { kind: "new-identity", identityId: identity.id }, identity);
        return identity;
      }),
    deleteIdentity: (identityId) =>
      exclusive(async () => {
        await execute(deps, { kind: "delete-identity", identityId });
      }),
  };
}
