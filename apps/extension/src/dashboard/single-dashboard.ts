import * as v from "valibot";
import type { DashboardTab } from "@/dashboard/dashboard-tab";
import {
  HAND_OVER_CHANNEL,
  HandOverMessageSchema,
  handOverMessage,
} from "@/messaging/dashboard-protocol";
import { claimLock, DASHBOARD_LOCK } from "@/messaging/view-locks";

/**
 * Keeps one dashboard tab. The first to claim the lock stays and shows the routes of later
 * tabs, which hand them over and close, whatever order Chrome gave their ids.
 */
export function claimDashboard(page: Window, tab?: DashboardTab): () => void {
  let release: (() => void) | undefined;
  let stopped = false;
  const channel = new BroadcastChannel(HAND_OVER_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    const parsed = v.safeParse(HandOverMessageSchema, data);
    if (release === undefined || !parsed.success) return;
    // A hash-only change does not reload this tab, so its PiP panel stays open.
    if (parsed.output.hash) page.location.hash = parsed.output.hash;
    void tab?.focus();
  };
  void claimLock(DASHBOARD_LOCK).then(async (held) => {
    if (stopped) return held?.();
    if (held !== undefined) {
      release = held;
      return;
    }
    channel.postMessage(handOverMessage(page.location.hash));
    await tab?.close();
  });
  return () => {
    stopped = true;
    release?.();
    channel.close();
  };
}
