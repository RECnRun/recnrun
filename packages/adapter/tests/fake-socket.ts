import type { RawSocket } from "../src/raw-cdp.ts";

type Listener = (event: { data?: unknown }) => void;

/** A scripted WebSocket: `emit` plays Chrome's side, `sent` records what the client sent. */
export class FakeSocket implements RawSocket {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}
