import type { FlowStore } from "@recnrun/persistence";
import { FlowStoreError } from "@recnrun/persistence";
import {
  validateFlow,
  type FlowStoreErrorCode,
  type LeaseFence,
  type ServiceError,
} from "@recnrun/protocol";
import { controlled, handoff, startPicking, stopPicking } from "./control.ts";
import type { CommandHandlers } from "./dispatch.ts";
import { ServiceFailure } from "./dispatch.ts";
import { addAssertion, finalize, suggestions } from "./drafts.ts";
import { compare, getArtifact, queryEvents } from "./run-queries.ts";
import { runSummary, startReplay, type RunDeps } from "./runs.ts";
import {
  pause,
  resume,
  sessionOf,
  startSession,
  statusOf,
  stopSession,
  type SessionDeps,
} from "./sessions.ts";

/** Everything the session, flow, run, and event commands share. */
export type CommandDeps = SessionDeps & RunDeps;

const STORE_CODES: Record<FlowStoreErrorCode, ServiceError["code"]> = {
  "not-found": "not-found",
  unreadable: "internal",
  "not-json": "invalid-request",
  "not-yaml": "invalid-request",
  invalid: "invalid-request",
  "revision-mismatch": "conflict",
  "revision-conflict": "conflict",
  "run-exists": "conflict",
  "flow-exists": "conflict",
};

/** A flow store error answers with the code a client can act on. */
async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FlowStoreError)
      throw new ServiceFailure(STORE_CODES[error.code], error.message);
    throw error;
  }
}

/** Validates like `flow.validate`, then stores a new revision when the flow changed. */
async function saveChecked(store: FlowStore, input: unknown) {
  const checked = validateFlow(input);
  if (!checked.ok)
    throw new ServiceFailure("invalid-request", checked.issues.map((i) => i.message).join("; "));
  const saved = await stored(() => store.saveFlow(checked.flow));
  return { flowId: checked.flow.id, revision: saved.revision };
}

function sessionCommands(deps: CommandDeps): CommandHandlers {
  const of = (sessionId: string) => sessionOf(deps, sessionId);
  // Every command that changes a session needs the holder's fence; only manual takeover does not.
  const held = (sessionId: string, fence: LeaseFence | undefined) =>
    controlled(deps, of(sessionId), fence);
  return {
    "profiles.list": async () => ({ profiles: await deps.bindings.list() }),
    "session.start": (params) => startSession(deps, params),
    "session.status": async ({ sessionId }) => statusOf(deps, of(sessionId)),
    "session.pause": async ({ sessionId, mode }, { lease }) =>
      pause(deps, held(sessionId, lease), mode),
    "session.resume": async ({ sessionId, mode }, { lease }) =>
      resume(deps, held(sessionId, lease), mode),
    "session.stop": ({ sessionId }, { lease }) => stopSession(deps, held(sessionId, lease)),
    "session.handoff": async ({ sessionId, to }, { lease }) =>
      handoff(deps, of(sessionId), to, lease),
    "session.suggestions": async ({ sessionId }) => suggestions(of(sessionId)),
    "picker.start": ({ sessionId }, { lease }) => startPicking(deps, of(sessionId), lease),
    "picker.stop": ({ sessionId }, { lease }) => stopPicking(held(sessionId, lease)),
    "flow.addAssertion": async ({ sessionId, step }, { lease }) =>
      addAssertion(held(sessionId, lease), step),
    "flow.finalize": ({ sessionId }, { lease }) =>
      stored(() => finalize(deps, deps.store(), held(sessionId, lease))),
  };
}

function flowCommands(deps: CommandDeps): CommandHandlers {
  return {
    "flow.validate": async ({ flow }) => validateFlow(flow),
    "flow.list": async () => ({ flows: (await deps.store().list()).flows }),
    "flow.get": ({ flowId }) =>
      stored(async () => {
        const { flow, manifest, revision } = await deps.store().get(flowId);
        return { flow, manifest, revision };
      }),
    "flow.save": ({ flow }) => saveChecked(deps.store(), flow),
    "flow.import": ({ flow }) => saveChecked(deps.store(), flow),
    "flow.duplicate": ({ flowId, newId, name }) =>
      stored(async () => {
        const saved = await deps.store().duplicateFlow(flowId, { id: newId, name });
        return { flowId: newId, revision: saved.revision };
      }),
    "flow.getRevision": ({ flowId, revision }) =>
      stored(async () => ({ flow: await deps.store().getRevision(flowId, revision), revision })),
    "flow.replay": (params) => stored(() => startReplay(deps, params)),
    "run.summary": ({ runId }) => stored(() => runSummary(deps, runId)),
    "run.queryEvents": (query) => stored(() => queryEvents(deps, query)),
    "run.compare": (runs) => stored(() => compare(deps, runs)),
    "run.getArtifact": (request) => stored(() => getArtifact(deps, request)),
  };
}

function eventCommands(deps: CommandDeps): CommandHandlers {
  let next = 0;
  return {
    "events.subscribe": async (filter, { channel }) => {
      if (channel === undefined)
        throw new ServiceFailure("invalid-request", "Subscribe over the /ws WebSocket.");
      channel.onClose(deps.hub.subscribe(filter, (message) => channel.push(message)));
      next += 1;
      return { subscriptionId: `subscription-${next}` };
    },
  };
}

/** The commands of recording sessions, stored flows, replays, and pushed events. */
export function createCommands(deps: CommandDeps): CommandHandlers {
  return { ...sessionCommands(deps), ...flowCommands(deps), ...eventCommands(deps) };
}
