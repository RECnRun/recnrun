import { errorMessage, nextIdentityName, planLifecycle } from "@recnrun/domain";
import type {
  Identity,
  LifecycleCommand,
  LifecycleState,
  LifecycleStep,
  ManagedWindowState,
  SkippedOrigin,
  WorkspaceOperation,
} from "@recnrun/domain";
import type { StepTiming } from "@/background/workspace/bootstrap";
import type { CaptureSummary } from "@/background/workspace/capture";
import { WorkspaceError } from "@/background/workspace/errors";
import { validIdentity } from "@/background/workspace/identity-draft";
import type {
  LifecycleCommands,
  LifecycleDeps,
  LifecycleKind,
  Opening,
} from "@/background/workspace/lifecycle-types";

interface Run {
  deps: LifecycleDeps;
  kind: LifecycleKind;
  operation: WorkspaceOperation;
  /** The identity the open window holds, and the window, while one is open. */
  open?: { identity: Identity; managed: ManagedWindowState };
  target?: Identity;
  /** A new identity, saved only once the open one is saved and closed. */
  adding?: Identity;
  /** The target's start, loaded before the open identity is captured or closed. */
  opening?: Opening;
  captured?: CaptureSummary;
  /** Set once the open identity names the new capture as its last one. */
  persisted?: boolean;
  /** Set once the session's windows closed, with every tab the capture moved. */
  closed?: boolean;
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

/**
 * Closes every window of the session, read again, once the capture saw each of its tabs: a tab
 * opened while it ran would close unsaved, and a window found after the session ended holds no
 * identity.
 */
async function closeOpen(run: Run): Promise<void> {
  const { session, foreign, tabs } = await run.deps.effects.windows();
  if (foreign.length > 0) {
    const message = "The capture is saved; close the other Incognito windows first.";
    throw new WorkspaceError("IncognitoWindowsOpen", message);
  }
  const seen = new Set(run.captured?.tabs);
  if (run.captured && tabs.some((tabId) => !seen.has(tabId))) {
    const message =
      "The capture is saved; an Incognito tab opened while it ran, so run the command again to save it too.";
    throw new WorkspaceError("TabsChanged", message);
  }
  if (session.length > 0) await run.deps.effects.close(session);
  run.closed = true;
  await run.deps.effects.endSession();
}

/** The tabs the capture left off their page get it back when the windows stay open. */
async function bringBack(run: Run): Promise<void> {
  const away = run.closed === true ? [] : (run.captured?.away ?? []);
  if (away.length > 0) await run.deps.effects.returnTabs(away);
}

async function persist(run: Run): Promise<void> {
  const { open, captured, deps } = run;
  if (open === undefined || captured === undefined) return;
  const lastCapture = {
    id: captured.captureId,
    at: (deps.now ?? Date.now)(),
    bytes: captured.bytes,
  };
  const id = open.identity.id;
  await deps.identities.update((list) =>
    list.map((each) => (each.id === id ? noted({ ...each, lastCapture }, captured.skipped) : each)),
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

/** The identity with `skipped` as the origins its last save or restore left out, or none. */
function noted(identity: Identity, skipped: readonly SkippedOrigin[]): Identity {
  const { skipped: _previous, ...rest } = identity;
  return skipped.length === 0 ? rest : { ...rest, skipped: [...skipped] };
}

async function start(run: Run): Promise<void> {
  const { target, adding, opening, deps, kind } = run;
  if (target === undefined || opening === undefined) return;
  if (adding) await deps.identities.update((current) => [...current, adding]);
  const started = await deps.effects.start(target, opening, { id: run.operation.id, kind });
  run.timings = started.timings;
  // The last save's notes stay; this start's replace the last start's.
  const saved = (target.skipped ?? []).filter(({ work }) => work === "save");
  const skipped = [...saved, ...started.skipped];
  if (skipped.length === 0 && target.skipped === undefined) return;
  await deps.identities.update((list) =>
    list.map((each) => (each.id === target.id ? noted(each, skipped) : each)),
  );
}

const STEP_RUNS: Record<LifecycleStep, (run: Run) => Promise<void>> = {
  capture: async (run) => {
    if (run.open === undefined) return;
    const { identity, managed } = run.open;
    run.captured = await run.deps.effects.capture(identity, managed, run.operation.id);
    const { skipped } = run.captured;
    // Journaled with the next step, so the operation names each origin the save left out.
    if (skipped.length > 0) run.operation = { ...run.operation, skipped };
  },
  persist,
  close: closeOpen,
  "start-from-capture": start,
  "start-empty": start,
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
      await bringBack(run);
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
  // A target whose capture cannot be read refuses here, before the open identity is touched.
  const startStep = plan.steps.find((step) => START_STEPS.has(step));
  if (startStep !== undefined && run.target !== undefined) {
    const from = startStep === "start-from-capture" ? "capture" : "empty";
    run.opening = await deps.effects.load(run.target, from);
  }
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

/** The next free letter among the saved identities' labels. */
async function nextName(deps: LifecycleDeps): Promise<string> {
  return nextIdentityName((await deps.identities.list()).map(({ label }) => label));
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
    newIdentity: (draft) =>
      exclusive(async () => {
        const label = draft.label ?? (await nextName(deps));
        const identity = validIdentity({ label, url: draft.url }, (deps.now ?? Date.now)());
        await access();
        await execute(deps, { kind: "new-identity", identityId: identity.id }, identity);
        return identity;
      }),
    closeWindows: (windowIds) =>
      exclusive(async () => {
        await access();
        await closeShown(deps, windowIds);
      }),
    deleteIdentity: (identityId) =>
      exclusive(async () => {
        await execute(deps, { kind: "delete-identity", identityId });
      }),
  };
}
