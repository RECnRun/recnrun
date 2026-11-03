import { FakeChannel } from "./fake-channel.ts";
import type { RawTarget } from "./fake-cdp.ts";

const PAGE = { type: "page", url: "about:blank" };
const STATUS = { node: { localName: "output", attributes: ["data-testid", "status"] } };

/** Chrome's browser endpoint: lanes are browser sessions L1, L2, …; an attach's event precedes its reply. */
export class ChromeChannel extends FakeChannel {
  /** Methods Chrome never answers. */
  readonly holding = new Set<string>();
  /** What `Target.getTargets` answers. */
  targets: RawTarget[] = [];
  private lanes = 0;

  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const reply = super.send(method, params, sessionId);
    if (this.holding.has(method)) return new Promise<unknown>(() => undefined);
    const answer = this.answer(method, params, sessionId);
    return answer === undefined ? reply : reply.then(() => answer);
  }

  /** Chrome reports a session attached under `parent`: a lane, or one of its sessions. */
  attachOn(parent: string | undefined, sessionId: string, targetId: string, type = "page") {
    this.emit(
      "Target.attachedToTarget",
      { sessionId, targetInfo: { ...PAGE, type, targetId }, waitingForDebugger: false },
      parent,
    );
  }

  private answer(method: string, params?: Record<string, unknown>, sessionId?: string): unknown {
    switch (method) {
      case "Target.attachToBrowserTarget":
        this.lanes += 1;
        return { sessionId: `L${this.lanes}` };
      case "Target.attachToTarget": {
        const targetId = String(params?.["targetId"]);
        this.attachOn(sessionId, `A-${targetId}`, targetId);
        return { sessionId: `A-${targetId}` };
      }
      case "Target.createTarget":
        return { targetId: "ROOT" };
      case "Target.getTargets":
        return { targetInfos: this.targets };
      case "DOM.describeNode":
        return STATUS;
      default:
        return undefined;
    }
  }
}
