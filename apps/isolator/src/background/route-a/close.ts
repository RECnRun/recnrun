import { messageOf, PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import type { DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { ChildSessions } from "@/background/route-a/children";
import type { CloseReport } from "@/background/route-a/types";

async function outcome(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return "ok";
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * Stops a worker without the harness touching it (E3 cold start): attaches by id, sends
 * `Target.closeTarget` on the target's own session, detaches the armed tabs' child sessions on
 * it, detaches, and says whether it is still listed.
 */
export async function closeTarget(
  api: DebuggerApi,
  targetId: string,
  { now, children }: { now: () => number; children: ChildSessions },
): Promise<CloseReport> {
  const target = { targetId };
  const start = now();
  const attach = await outcome(withTimeout(api.attach(target, PROTOCOL_VERSION), "attach"));
  const close =
    attach === "ok"
      ? await outcome(command(api, target, "Target.closeTarget", { targetId }))
      : "not sent";
  const closed = now();
  const sessions = close === "ok" ? await children.detach(api, targetId) : [];
  const detach =
    attach === "ok" ? await outcome(withTimeout(api.detach(target), "detach")) : "not sent";
  const detached = now();
  const listedAfter = (await api.getTargets()).some((item) => item.id === targetId);
  return {
    targetId,
    attach,
    close,
    detach,
    listedAfter,
    at: { start, closed, detached },
    sessions,
  };
}
