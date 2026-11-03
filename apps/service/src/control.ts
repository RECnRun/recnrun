import { suggestLocators, type LeaseRegistry } from "@recnrun/engine";
import type { ControlState, LeaseFence, SessionStatus } from "@recnrun/protocol";
import { ServiceFailure } from "./dispatch.ts";
import { announce, PERSON, type LiveSession, type SessionDeps } from "./sessions.ts";

const isLive = (live: LiveSession) =>
  live.state.state === "recording" || live.state.state === "paused";

function requireLive(live: LiveSession): void {
  if (!isLive(live)) throw new ServiceFailure("conflict", `The session is ${live.state.state}.`);
}

/**
 * While someone holds the target, only a request carrying their current fence acts on it; a
 * fence that matches no live lease (passed on, released, or expired) acts on nothing.
 */
function requireFence(leases: LeaseRegistry, targetId: string, fence: LeaseFence | undefined) {
  const lease = leases.current(targetId);
  if (fence === undefined ? lease === undefined : leases.authorize(targetId, fence).ok)
    return lease;
  throw new ServiceFailure(
    "stale-lease",
    lease === undefined
      ? "The lease expired or was released; take control again to act on the page."
      : `The page is controlled by ${lease.holderId}; send its current lease to act on it.`,
  );
}

/** The session, once the request's fence may act on its page. */
export function controlled(
  deps: SessionDeps,
  live: LiveSession,
  fence: LeaseFence | undefined,
): LiveSession {
  requireFence(deps.leases, live.targetId, fence);
  return live;
}

function grant(leases: LeaseRegistry, targetId: string, to: Exclude<ControlState, "unassigned">) {
  const holder = to === "manual" ? PERSON : to;
  const result = leases.acquire(targetId, { id: holder, kind: to });
  if (!result.ok) throw new ServiceFailure("conflict", `The page is controlled by another client.`);
}

/**
 * A person takes control at once; any other change releases the current holder first, which
 * needs that holder's fence, then grants the new one.
 */
export function handoff(
  deps: SessionDeps,
  live: LiveSession,
  to: ControlState,
  fence: LeaseFence | undefined,
): SessionStatus {
  requireLive(live);
  const { leases } = deps;
  const current = leases.control(live.targetId);
  if (to === current) return announce(deps, live);
  if (to === "manual") {
    leases.takeControl(live.targetId, PERSON);
    return announce(deps, live);
  }
  const lease = requireFence(leases, live.targetId, fence);
  if (lease) leases.release(live.targetId, lease);
  if (to !== "unassigned") grant(leases, live.targetId, to);
  return announce(deps, live);
}

/** Shows the picker on the session's page; each pick is pushed with its locator candidates. */
export async function startPicking(
  deps: SessionDeps,
  live: LiveSession,
  fence: LeaseFence | undefined,
): Promise<{ sessionId: string; picking: boolean }> {
  requireLive(live);
  requireFence(deps.leases, live.targetId, fence);
  live.picker ??= await deps.browser.pick(live.endpoint, live.targetId, (target) =>
    deps.hub.publish({
      type: "picker.picked",
      sessionId: live.id,
      target,
      locators: suggestLocators(target),
    }),
  );
  return { sessionId: live.id, picking: true };
}

export async function stopPicking(
  live: LiveSession,
): Promise<{ sessionId: string; picking: boolean }> {
  const picker = live.picker;
  live.picker = undefined;
  await picker?.stop();
  return { sessionId: live.id, picking: false };
}
