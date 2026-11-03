import { loopbackPage, loopbackTargetOf, requireLoopback } from "@/background/probes/loopback";
import type { TargetInfo } from "@/background/probes/types";
import type { Recorder } from "@/background/stop/recorder";

async function targets(recorder: Recorder): Promise<TargetInfo[]> {
  const listed = await recorder.record({ api: "debugger", method: "getTargets" }, async () => {
    const all = await recorder.debugger.getTargets();
    return all.map(({ type, id, url, attached, tabId }) => ({
      type,
      id,
      url,
      attached,
      ...(tabId === undefined ? {} : { tabId }),
    }));
  });
  if (listed.error !== undefined) throw new Error(listed.error);
  return listed.value;
}

/** The worker target `targetId`, refused when it is gone or outside the loopback. */
export async function loopbackTarget(recorder: Recorder, targetId: string): Promise<TargetInfo> {
  return loopbackTargetOf(await targets(recorder), targetId);
}

/** The page of tab `tabId`, refused when it is gone or outside the loopback. */
export async function loopbackTab(recorder: Recorder, tabId: number): Promise<TargetInfo> {
  return loopbackPage(await targets(recorder), tabId);
}

export function requireLoopbackOrigin(origin: string): void {
  requireLoopback("origin", origin);
}

/** Whether `targetId` is still listed; Chrome lists only running service workers. */
export async function isListed(recorder: Recorder, targetId: string): Promise<boolean> {
  return (await targets(recorder)).some((target) => target.id === targetId);
}

/** The service workers of `origin` (their scripts are named `/sw-*.js` in the fixture). */
export async function scopeWorkers(recorder: Recorder, origin: string): Promise<TargetInfo[]> {
  return (await targets(recorder)).filter(
    (target) => target.type !== "page" && target.url.startsWith(`${origin}/sw-`),
  );
}
