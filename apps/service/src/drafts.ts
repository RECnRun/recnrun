import { normalize, replayableAssertion, toFlowSteps } from "@recnrun/engine";
import type { FlowStore } from "@recnrun/persistence";
import {
  validateFlow,
  type AssertionStep,
  type Flow,
  type NormalizationResult,
} from "@recnrun/protocol";
import { ServiceFailure } from "./dispatch.ts";
import { advance, announce, type LiveSession, type SessionDeps } from "./sessions.ts";

/** The steps the captured events suggest so far, leaving out what was done while step creation paused. */
export function suggestions(live: LiveSession): NormalizationResult {
  return normalize(live.events.filter((event) => !live.ignored.has(event.id)));
}

/** Adds an assertion the person wrote to the session's draft; finalize appends it after the steps. */
export function addAssertion(live: LiveSession, step: AssertionStep): { stepId: string } {
  if (live.state.state === "completed" || live.state.state === "interrupted")
    throw new ServiceFailure("conflict", `The session is ${live.state.state}.`);
  if (live.assertions.some(({ id }) => id === step.id))
    throw new ServiceFailure("conflict", `The draft already has a step ${step.id}.`);
  live.assertions.push(step);
  return { stepId: step.id };
}

function draftOf(live: LiveSession, now: number): Flow {
  return {
    schemaVersion: 1,
    id: live.flowId ?? `flow-${live.id.slice("session-".length, "session-".length + 8)}`,
    name: live.flowId ?? `Recording of ${new Date(now).toISOString()}`,
    actors: {},
    inputs: {},
    requirements: [],
    preconditions: [],
    steps: [...toFlowSteps(suggestions(live).steps), ...live.assertions.map(replayableAssertion)],
  };
}

/** Turns a stopped session into a stored flow: suggested steps, then the draft assertions. */
export async function finalize(
  deps: SessionDeps,
  store: FlowStore,
  live: LiveSession,
): Promise<{ flowId: string; revision: string }> {
  if (live.state.state !== "finalizing")
    throw new ServiceFailure(
      "conflict",
      `Stop the session before finalizing; it is ${live.state.state}.`,
    );
  const checked = validateFlow(draftOf(live, deps.now()));
  if (!checked.ok)
    throw new ServiceFailure(
      "invalid-request",
      checked.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const saved = await store.saveFlow(checked.flow, { status: "recorded" });
  advance(live, "complete");
  announce(deps, live);
  return { flowId: checked.flow.id, revision: saved.revision };
}
