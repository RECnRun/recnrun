import { messageOf } from "@/background/probes/helpers";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { SessionDetach } from "@/background/route-a/types";

interface Child {
  /** The session whose auto-attach reported the child, which must send its detach. */
  parent: Debuggee;
  targetId: string;
}

/**
 * The auto-attached child sessions of the armed tabs. E8: a child session on a service worker
 * survives `Target.closeTarget`, so Chrome holds the restarted worker for it and never reports
 * the restart; detaching it lets the next start auto-attach, waiting, again.
 */
export class ChildSessions {
  readonly #children = new Map<string, Child>();

  add(source: Debuggee, sessionId: string, targetId: string): void {
    const parent = {
      tabId: source.tabId,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    };
    this.#children.set(sessionId, { parent, targetId });
  }

  remove(sessionId: string): void {
    this.#children.delete(sessionId);
  }

  /** Forgets a tab's children; Chrome drops them with the tab's own session. */
  dropTab(tabId: number): void {
    for (const [sessionId, child] of this.#children) {
      if (child.parent.tabId === tabId) this.#children.delete(sessionId);
    }
  }

  /** Detaches every child session on `targetId` through its parent and says how each went. */
  async detach(api: DebuggerApi, targetId: string): Promise<SessionDetach[]> {
    const detaches: SessionDetach[] = [];
    for (const [sessionId, child] of this.#children) {
      if (child.targetId !== targetId) continue;
      this.#children.delete(sessionId);
      const detach = await command(api, child.parent, "Target.detachFromTarget", { sessionId })
        .then(() => "ok")
        .catch(messageOf);
      detaches.push({ sessionId, detach });
    }
    return detaches;
  }
}
