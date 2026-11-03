import * as v from "valibot";
import type { CdpChannel, CdpEvent } from "./cdp-socket.ts";

/** One browser socket shared by several owners, each on a browser-level session of its own. */
export interface CdpHub {
  /** Opens a lane: a channel over the shared socket with auto-attach and sessions of its own. */
  lane(): Promise<CdpChannel>;
  /** A command on the browser's own session, for queries that attach to nothing. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The targets the lanes hold sessions on right now. */
  held(): ReadonlySet<string>;
  /** Called once if the shared socket closes or fails without `close()`. */
  onClose(listener: () => void): void;
  /** Closes the socket; the lanes it still carried learn of it through their close listeners. */
  close(): void;
}

const LaneSchema = v.object({ sessionId: v.pipe(v.string(), v.nonEmpty()) });
const AttachedSchema = v.object({
  sessionId: v.string(),
  targetInfo: v.object({ targetId: v.string() }),
});
const DetachedSchema = v.object({ sessionId: v.string() });

interface Lane {
  readonly id: string;
  readonly listeners: ((event: CdpEvent) => void)[];
  readonly closeListeners: (() => void)[];
  readonly pending: Set<(error: Error) => void>;
  closed: boolean;
}

/** Which lane each session belongs to: lanes by their id, their sessions by the attach that made them. */
class Ownership {
  readonly lanes = new Map<string, Lane>();
  private readonly sessions = new Map<string, { lane: Lane; targetId: string }>();

  /** The lane an event belongs to; a lane's own events lose the session id, as on a socket of its own. */
  route(event: CdpEvent): { lane: Lane; event: CdpEvent } | undefined {
    if (event.sessionId === undefined) return undefined;
    const lane = this.lanes.get(event.sessionId);
    if (lane) {
      this.track(lane, event);
      return { lane, event: { method: event.method, params: event.params } };
    }
    const owner = this.sessions.get(event.sessionId)?.lane;
    if (!owner) return undefined;
    this.track(owner, event);
    return { lane: owner, event };
  }

  held(): ReadonlySet<string> {
    return new Set([...this.sessions.values()].map(({ targetId }) => targetId));
  }

  forget(lane: Lane): void {
    this.lanes.delete(lane.id);
    for (const [sessionId, owner] of this.sessions)
      if (owner.lane === lane) this.sessions.delete(sessionId);
  }

  private track(lane: Lane, event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const attached = v.safeParse(AttachedSchema, event.params);
      if (attached.success) {
        const { sessionId, targetInfo } = attached.output;
        this.sessions.set(sessionId, { lane, targetId: targetInfo.targetId });
      }
    } else if (event.method === "Target.detachedFromTarget") {
      const detached = v.safeParse(DetachedSchema, event.params);
      if (detached.success) this.sessions.delete(detached.output.sessionId);
    }
  }
}

/** The lane's carrier went away under it: whatever it awaited fails, and it hears about it once. */
function cut(lane: Lane, error: () => Error): void {
  if (lane.closed) return;
  lane.closed = true;
  for (const reject of lane.pending) reject(error());
  lane.pending.clear();
  for (const listener of lane.closeListeners) listener();
}

function laneChannel(lane: Lane, root: CdpChannel, ownership: Ownership): CdpChannel {
  const closedError = () => new Error(`CDP lane ${lane.id} closed.`);
  return {
    send: (method, params, sessionId) =>
      new Promise((resolve, reject) => {
        if (lane.closed) {
          reject(closedError());
          return;
        }
        lane.pending.add(reject);
        root.send(method, params, sessionId ?? lane.id).then(
          (result) => {
            lane.pending.delete(reject);
            resolve(result);
          },
          (error: Error) => {
            lane.pending.delete(reject);
            reject(error);
          },
        );
      }),
    onEvent: (listener) => lane.listeners.push(listener),
    onClose: (listener) => lane.closeListeners.push(listener),
    close: () => {
      if (lane.closed) return;
      lane.closed = true;
      ownership.forget(lane);
      for (const reject of lane.pending) reject(closedError());
      lane.pending.clear();
      // Detaching the lane's browser session detaches every session attached under it.
      root.send("Target.detachFromTarget", { sessionId: lane.id }).catch(() => undefined);
    },
  };
}

/**
 * Shares one browser-level socket: each lane is a `Target.attachToBrowserTarget` session, so its
 * auto-attach, its attaches, and their events stay its own, and Chrome asks once per socket.
 */
export function cdpHub(root: CdpChannel): CdpHub {
  const ownership = new Ownership();
  const closeListeners: (() => void)[] = [];
  let closed = false;
  const lostError = () => new Error("CDP socket closed.");
  root.onEvent((event) => {
    const routed = ownership.route(event);
    if (routed) for (const listener of routed.lane.listeners) listener(routed.event);
  });
  root.onClose(() => {
    closed = true;
    const lanes = [...ownership.lanes.values()];
    for (const lane of lanes) ownership.forget(lane);
    for (const lane of lanes) cut(lane, lostError);
    for (const listener of closeListeners) listener();
  });
  return {
    async lane() {
      if (closed) throw lostError();
      const { sessionId } = v.parse(LaneSchema, await root.send("Target.attachToBrowserTarget"));
      if (closed) throw lostError();
      const lane: Lane = {
        id: sessionId,
        listeners: [],
        closeListeners: [],
        pending: new Set(),
        closed: false,
      };
      ownership.lanes.set(sessionId, lane);
      return laneChannel(lane, root, ownership);
    },
    send: (method, params) => root.send(method, params),
    held: () => ownership.held(),
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      if (closed) return;
      closed = true;
      const lanes = [...ownership.lanes.values()];
      for (const lane of lanes) ownership.forget(lane);
      root.close();
      for (const lane of lanes) cut(lane, lostError);
    },
  };
}
