import { withMarker } from "@recnrun/worker-bootstrap";
import type { Debuggee, EventListener } from "@/background/probes/types";
import type { Recorder } from "@/background/stop/recorder";
import type { WatchEvent } from "@/background/stop/types";

const RELOADED = "Inspector.targetReloadedAfterCrash";
/** What a session sees when its worker stops and starts again under it (Chromium sends them unasked). */
const WATCHED = new Set([
  "Inspector.targetCrashed",
  RELOADED,
  "Inspector.detached",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
]);
// A paused worker answers the bootstrap only once released, so its reply is awaited last.
const BOOTSTRAP_MS = 10_000;

/**
 * Records the events of workers that stop and restart under a session the isolator holds and,
 * with a marker, bootstraps a restarted worker before releasing it, as Route A does on attach.
 */
export class Watcher {
  readonly events: WatchEvent[] = [];
  readonly #recorder: Recorder;
  readonly #marker: string | undefined;
  readonly #pending = new Set<Promise<void>>();
  readonly #listener: EventListener;

  constructor(recorder: Recorder, marker: string | undefined) {
    this.#recorder = recorder;
    this.#marker = marker;
    this.#listener = (source, method, params) => this.#seen(source, method, params);
    recorder.debugger.onEvent.addListener(this.#listener);
  }

  async stop(): Promise<void> {
    this.#recorder.debugger.onEvent.removeListener(this.#listener);
    await Promise.allSettled(this.#pending);
  }

  #seen(source: Debuggee, method: string, params: object | undefined): void {
    if (!WATCHED.has(method)) return;
    const event: WatchEvent = {
      at: this.#recorder.now(),
      method,
      source: { ...source },
      ...(params === undefined ? {} : { params }),
    };
    this.events.push(event);
    if (method !== RELOADED || this.#marker === undefined) return;
    const handled = this.#bootstrap(source, event, this.#marker);
    this.#pending.add(handled);
    void handled.finally(() => this.#pending.delete(handled));
  }

  async #bootstrap(session: Debuggee, event: WatchEvent, marker: string): Promise<void> {
    const params = { expression: withMarker(marker), returnByValue: true };
    const evaluation = this.#recorder.send(session, "Runtime.evaluate", params, BOOTSTRAP_MS);
    const released = await this.#recorder.send(session, "Runtime.runIfWaitingForDebugger");
    event.released = released.error ?? "ok";
    const reply = await evaluation;
    event.bootstrap =
      reply.error === undefined
        ? { installed: (reply.value.result as { value?: unknown } | undefined)?.value }
        : { error: reply.error };
  }
}
