import type { CdpChannel, CdpEvent } from "../src/cdp-socket.ts";

export interface SentCommand {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** A scripted browser-level CDP channel: `emit` plays Chrome's events, `failing` rejects methods. */
export class FakeChannel implements CdpChannel {
  readonly sent: SentCommand[] = [];
  readonly failing = new Map<string, string>();
  closed = false;
  private readonly listeners: ((event: CdpEvent) => void)[] = [];

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, ...(params && { params }), ...(sessionId && { sessionId }) });
    const failure = this.failing.get(method);
    return failure ? Promise.reject(new Error(failure)) : Promise.resolve({});
  }

  onEvent(listener: (event: CdpEvent) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const listener of this.listeners)
      listener({ method, params, ...(sessionId && { sessionId }) });
  }

  /** The methods sent on one session, in order. */
  methods(sessionId: string): string[] {
    return this.sent.filter((each) => each.sessionId === sessionId).map(({ method }) => method);
  }

  attach(
    sessionId: string,
    targetInfo: { targetId: string; type: string; url?: string },
    waiting = true,
  ): void {
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: { url: "about:blank", ...targetInfo },
      waitingForDebugger: waiting,
    });
  }
}
