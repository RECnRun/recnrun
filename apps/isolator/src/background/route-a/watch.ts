import { messageOf, PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import type { DebuggerApi, TargetInfo } from "@/background/probes/types";
import { bootstrap } from "@/background/route-a/attached";
import type { WatchRequest } from "@/background/route-a/requests";
import type { JournalEntry, WatchReport } from "@/background/route-a/types";

// chrome.debugger lists service and shared workers as `worker` and dedicated workers as `other` (E1).
const WATCHED_TYPES = new Set(["worker", "other"]);

/**
 * Route A without a tab (P1.2, E3): polls `getTargets()` and attaches each new worker target of
 * the origin by id, then evaluates the bootstrap. A direct attach never pauses the worker.
 */
export class TargetWatch {
  readonly #api: DebuggerApi;
  readonly #request: WatchRequest;
  readonly #now: () => number;
  readonly #baseline = new Set<string>();
  readonly #seen = new Set<string>();
  readonly #attached: string[] = [];
  readonly #entries: JournalEntry[] = [];
  readonly #pending = new Set<Promise<void>>();
  readonly #pollErrors: string[] = [];
  #polls = 0;
  #polling: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(api: DebuggerApi, request: WatchRequest, now: () => number) {
    this.#api = api;
    this.#request = request;
    this.#now = now;
  }

  /** Takes the origin's worker targets listed now as stale, then starts polling. */
  async start(): Promise<{ intervalMs: number; staleSkipped: number }> {
    const targets = await this.#api.getTargets();
    for (const target of targets.filter((item) => this.#matches(item))) {
      this.#baseline.add(target.id);
    }
    this.#timer = setInterval(() => this.#tick(), this.#request.intervalMs);
    return { intervalMs: this.#request.intervalMs, staleSkipped: this.#baseline.size };
  }

  async stop(): Promise<WatchReport> {
    clearInterval(this.#timer);
    await this.#polling;
    await Promise.allSettled(this.#pending);
    for (const targetId of this.#attached) {
      await withTimeout(this.#api.detach({ targetId }), "detach").catch(() => undefined);
    }
    const { origin, marker, intervalMs } = this.#request;
    return {
      origin,
      marker,
      intervalMs,
      staleSkipped: this.#baseline.size,
      polls: this.#polls,
      pollErrors: [...this.#pollErrors],
      entries: this.#entries.map((entry) => ({ ...entry })),
    };
  }

  #matches(target: TargetInfo): boolean {
    return WATCHED_TYPES.has(target.type) && target.url.startsWith(`${this.#request.origin}/`);
  }

  #tick(): void {
    if (this.#polling) return;
    this.#polling = this.#poll().finally(() => {
      this.#polling = undefined;
    });
  }

  async #poll(): Promise<void> {
    this.#polls += 1;
    let targets: TargetInfo[];
    try {
      targets = await this.#api.getTargets();
    } catch (error) {
      this.#pollErrors.push(messageOf(error));
      return;
    }
    const seenAt = this.#now();
    for (const target of targets) {
      if (!this.#matches(target) || this.#baseline.has(target.id) || this.#seen.has(target.id)) {
        continue;
      }
      this.#seen.add(target.id);
      const attached = this.#attach(target, seenAt);
      this.#pending.add(attached);
      void attached.finally(() => this.#pending.delete(attached));
    }
  }

  async #attach({ id, type, url }: TargetInfo, seenAt: number): Promise<void> {
    const entry: JournalEntry = {
      sessionId: "",
      targetId: id,
      type,
      url,
      waitingForDebugger: false,
      attachedAt: seenAt,
      marker: this.#request.marker,
      released: false,
    };
    this.#entries.push(entry);
    try {
      await withTimeout(this.#api.attach({ targetId: id }, PROTOCOL_VERSION), "attach");
    } catch (error) {
      entry.error = messageOf(error);
      return;
    }
    entry.attachMs = this.#now() - seenAt;
    this.#attached.push(id);
    await bootstrap(this.#api, { targetId: id }, entry, this.#now);
  }
}
