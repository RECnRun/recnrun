import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  applySessionEvent,
  createSession,
  createsSuggestedSteps,
  isCapturing,
  pauseSession,
  resumeSession,
  type CaptureGap,
  type LeaseRegistry,
  type LifecycleEvent,
  type Session,
  type SessionResult,
} from "@recnrun/engine";
import {
  openBlobStore,
  writeCoverage,
  type BindingsStore,
  type JournalWriter,
} from "@recnrun/persistence";
import {
  tallyCoverage,
  type AssertionStep,
  type CapturedEvent,
  type CoverageTally,
  type Event,
  type GapPayload,
  type PauseMode,
  type SessionStatus,
} from "@recnrun/protocol";
import {
  endpointOf,
  type BrowserPort,
  type PickerHandle,
  type RecordingHandle,
} from "./browser.ts";
import { ServiceFailure } from "./dispatch.ts";
import type { EventHub } from "./hub.ts";
import type { JournalRegistry } from "./journals.ts";
import type { Logger } from "./logger.ts";

/** The holder id of the person recording in Chrome. */
export const PERSON = "person";

/** A recording session the service runs: its page, journal, captured events, and draft assertions. */
export interface LiveSession {
  readonly id: string;
  readonly flowId: string | undefined;
  readonly endpoint: string;
  readonly targetId: string;
  readonly recording: RecordingHandle;
  readonly journal: JournalWriter;
  /** Counts what the journal holds, for `coverage.json` at stop. */
  readonly coverage: CoverageTally;
  readonly events: CapturedEvent[];
  /** Events captured while step creation was paused; they never become steps. */
  readonly ignored: Set<string>;
  readonly assertions: AssertionStep[];
  readonly writes: Set<Promise<void>>;
  state: Session;
  gaps: number;
  picker?: PickerHandle | undefined;
  /** The state at stop, while capture already under way still lands as the session was then. */
  draining?: Session | undefined;
  /** The last picker start or stop; the next one waits for it. */
  pickerTurn: Promise<void>;
}

export interface SessionDeps {
  home: string;
  browser: BrowserPort;
  bindings: BindingsStore;
  journals: JournalRegistry;
  hub: EventHub;
  leases: LeaseRegistry;
  logger: Logger;
  now: () => number;
  sessions: Map<string, LiveSession>;
}

export function sessionOf(deps: SessionDeps, sessionId: string): LiveSession {
  const live = deps.sessions.get(sessionId);
  if (live === undefined) throw new ServiceFailure("not-found", `No session ${sessionId}.`);
  return live;
}

export function statusOf(deps: SessionDeps, live: LiveSession): SessionStatus {
  const lease = deps.leases.current(live.targetId);
  return {
    sessionId: live.id,
    state: live.state.state,
    control: deps.leases.control(live.targetId),
    pauses: live.state.pauses,
    ...(lease && { lease }),
  };
}

/** Publishes the new status to subscribers and returns it. */
export function announce(deps: SessionDeps, live: LiveSession): SessionStatus {
  const status = statusOf(deps, live);
  deps.hub.publish({ type: "session.status", sessionId: live.id, status });
  return status;
}

/** Moves the session or refuses with `conflict`, naming the transition the machine forbids. */
function settle(live: LiveSession, result: SessionResult): CaptureGap | undefined {
  if (!result.ok)
    throw new ServiceFailure(
      "conflict",
      `The session is ${result.error.from}; it cannot ${result.error.event}.`,
    );
  live.state = result.session;
  return result.gap;
}

export const advance = (live: LiveSession, event: LifecycleEvent) =>
  settle(live, applySessionEvent(live.state, event));

/** Journals the event and answers that write, failure included, so the recording can account for it. */
function track(deps: SessionDeps, live: LiveSession, event: Event): Promise<void> {
  live.coverage.add(event);
  const line = live.journal.append(event);
  const write = line.catch((error: unknown) => {
    deps.logger.error("session.journal-failed", { message: String(error) });
  });
  live.writes.add(write);
  void write.finally(() => live.writes.delete(write));
  return line;
}

function accept(
  deps: SessionDeps,
  live: LiveSession,
  event: CapturedEvent,
): Promise<void> | undefined {
  const state = live.draining ?? live.state;
  if (!isCapturing(state)) return undefined;
  live.events.push(event);
  // Navigations make steps too, so the pause excludes every event, not only DOM ones.
  if (!createsSuggestedSteps(state)) live.ignored.add(event.id);
  const written = track(deps, live, event);
  deps.hub.publish({ type: "session.event", sessionId: live.id, event });
  // The person is active, so their control does not lapse while they record.
  const lease = deps.leases.current(live.targetId);
  if (lease?.holderId === PERSON) deps.leases.heartbeat(live.targetId, lease);
  return written;
}

/** F2 records one Chrome: every actor binds to the same profile, or none names one. */
async function profileFolder(
  deps: SessionDeps,
  actors: Readonly<Record<string, string>> = {},
): Promise<string | undefined> {
  const names = new Set(Object.values(actors));
  if (names.size > 1)
    throw new ServiceFailure("capability-unavailable", "A session records one Chrome profile.");
  const [name] = names;
  if (name === undefined) return undefined;
  const binding = (await deps.bindings.list()).find((entry) => entry.name === name);
  if (binding === undefined) throw new ServiceFailure("not-found", `No profile binding ${name}.`);
  return binding.userDataDir;
}

/** Opens the session's page in Chrome, captures it into its journal, and gives the person control. */
export async function startSession(
  deps: SessionDeps,
  params: { flowId?: string | undefined; actors?: Record<string, string> | undefined },
): Promise<SessionStatus> {
  const endpoint = await endpointOf(deps.browser, await profileFolder(deps, params.actors));
  const id = `session-${randomUUID()}`;
  const folder = join(deps.home, ".recnrun", "sessions", id);
  const journal = await deps.journals.open(join(folder, "events.jsonl"));
  const early: CapturedEvent[] = [];
  // An event before the session exists is kept; its write is only known once the session accepts it.
  let sink: (event: CapturedEvent) => void | Promise<void> = (event) => void early.push(event);
  let recording: RecordingHandle;
  try {
    // Bodies go to blobs beside the journal, so the journal keeps only their references.
    const blobs = await openBlobStore({ folder: join(folder, "blobs") });
    recording = await deps.browser.record(endpoint, {
      runId: id,
      onEvent: (event) => sink(event),
      blobs,
    });
  } catch (error) {
    await journal.close();
    throw error;
  }
  const live: LiveSession = {
    id,
    flowId: params.flowId,
    endpoint,
    targetId: recording.targetId,
    recording,
    journal,
    coverage: tallyCoverage(),
    events: [],
    ignored: new Set(),
    assertions: [],
    writes: new Set(),
    gaps: 0,
    state: createSession(),
    pickerTurn: Promise.resolve(),
  };
  advance(live, "start");
  deps.sessions.set(id, live);
  deps.leases.takeControl(live.targetId, PERSON);
  sink = (event) => accept(deps, live, event);
  for (const event of early) void sink(event);
  return announce(deps, live);
}

/** The journal line of a capture suspension, written once capture resumes. */
function gapEvent(
  deps: SessionDeps,
  live: LiveSession,
  gap: { reason: GapPayload["reason"]; startedAt: number },
): Event {
  live.gaps += 1;
  return {
    schemaVersion: 1,
    id: `${live.id}-gap-${live.gaps}`,
    runId: live.id,
    seq: live.gaps,
    source: "service",
    producer: "service:session",
    timestamp: new Date(deps.now()).toISOString(),
    targetId: null,
    frameId: null,
    documentId: null,
    type: "capture-suspended",
    category: "gap",
    payload: { reason: gap.reason, startedAt: new Date(gap.startedAt).toISOString() },
  };
}

export function pause(deps: SessionDeps, live: LiveSession, mode: PauseMode): SessionStatus {
  settle(live, pauseSession(live.state, mode, deps.now()));
  return announce(deps, live);
}

export function resume(deps: SessionDeps, live: LiveSession, mode: PauseMode): SessionStatus {
  const gap = settle(live, resumeSession(live.state, mode, deps.now()));
  if (gap) void track(deps, live, gapEvent(deps, live, gap));
  return announce(deps, live);
}

/** Runs picker starts and stops one at a time, so a slow startup cannot outlive a stop. */
export function serialPicker<T>(live: LiveSession, work: () => Promise<T>): Promise<T> {
  const next = live.pickerTurn.then(work);
  live.pickerTurn = next.then(
    () => {},
    () => {},
  );
  return next;
}

export async function closePicker(live: LiveSession): Promise<void> {
  const picker = live.picker;
  live.picker = undefined;
  await picker?.stop();
}

/**
 * Lets capture under way at stop land as the session was, then stops the recording; results it
 * could not deliver, and a suspension still open, are journaled as gaps.
 */
async function drain(deps: SessionDeps, live: LiveSession, stopping: Session): Promise<void> {
  try {
    await live.recording.settled();
  } catch (error) {
    deps.logger.warn("session.drain-failed", { message: String(error) });
    void track(
      deps,
      live,
      gapEvent(deps, live, { reason: "capture-stopped", startedAt: deps.now() }),
    );
  }
  live.recording.stop();
  live.draining = undefined;
  const suspendedAt = stopping.captureSuspendedAt;
  if (suspendedAt !== null)
    void track(
      deps,
      live,
      gapEvent(deps, live, { reason: "capture-suspended", startedAt: suspendedAt }),
    );
}

/** Ends capture: the picker and the recording stop, the journal closes, and control is released. */
export async function stopSession(deps: SessionDeps, live: LiveSession): Promise<SessionStatus> {
  const stopping = live.state;
  advance(live, "stop");
  live.draining = stopping;
  await serialPicker(live, () => closePicker(live));
  await drain(deps, live, stopping);
  await Promise.all(live.writes);
  await live.journal.close();
  const folder = join(deps.home, ".recnrun", "sessions", live.id);
  await writeCoverage(folder, live.coverage.coverage(live.id));
  const lease = deps.leases.current(live.targetId);
  if (lease) deps.leases.release(live.targetId, lease);
  return announce(deps, live);
}

/** Stops every session still capturing, for the service's shutdown. */
export async function stopAll(deps: SessionDeps): Promise<void> {
  const live = [...deps.sessions.values()].filter(({ state }) =>
    ["recording", "paused"].includes(state.state),
  );
  await Promise.allSettled(live.map((session) => stopSession(deps, session)));
}
