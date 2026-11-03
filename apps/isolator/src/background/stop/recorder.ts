import { messageOf, PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import type { Clock, StopApis, StopCall, StopJournal } from "@/background/stop/types";

/** Long strings (the bootstrap source) are recorded by length, so a journal stays readable. */
const RECORDED_STRING = 200;

export type Outcome<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function recordable(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === "string" && value.length > RECORDED_STRING
        ? `<${value.length} characters>`
        : value,
    ]),
  );
}

/** Makes every `chrome.*` call of one mechanism bounded and journaled, with Chrome's exact errors. */
export class Recorder {
  readonly calls: StopCall[] = [];
  readonly apis: StopApis;
  readonly #clock: Clock;
  readonly #startedAt: number;

  constructor(apis: StopApis, clock: Clock) {
    this.apis = apis;
    this.#clock = clock;
    this.#startedAt = clock.now();
  }

  get debugger(): DebuggerApi {
    return this.apis.debugger;
  }

  now(): number {
    return this.#clock.now();
  }

  async record<T>(
    call: Pick<StopCall, "api" | "method" | "target" | "params">,
    invoke: () => Promise<T>,
    ms?: number,
  ): Promise<Outcome<T>> {
    const { params, ...rest } = call;
    const entry: StopCall = {
      ...rest,
      ...(params ? { params: recordable(params) } : {}),
      startedAt: this.now(),
      endedAt: Number.NaN,
    };
    this.calls.push(entry);
    try {
      const value = await withTimeout(invoke(), call.method, ms);
      entry.result = value ?? null;
      return { value };
    } catch (error) {
      entry.error = messageOf(error);
      return { error: entry.error };
    } finally {
      entry.endedAt = this.now();
    }
  }

  send(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>,
    ms?: number,
  ): Promise<Outcome<Record<string, unknown>>> {
    const call = { api: "debugger" as const, method, target, ...(params ? { params } : {}) };
    const reply = async () => (await this.debugger.sendCommand(target, method, params)) ?? {};
    return this.record(call, reply as () => Promise<Record<string, unknown>>, ms);
  }

  attach(target: Debuggee): Promise<Outcome<void>> {
    const call = { api: "debugger" as const, method: "attach", target };
    return this.record(call, () => this.debugger.attach(target, PROTOCOL_VERSION));
  }

  detach(target: Debuggee): Promise<Outcome<void>> {
    return this.record({ api: "debugger", method: "detach", target }, () =>
      this.debugger.detach(target),
    );
  }

  journal(mechanism: string, outcome: Record<string, unknown>): StopJournal {
    return {
      mechanism,
      timeOrigin: this.#clock.timeOrigin,
      startedAt: this.#startedAt,
      endedAt: this.now(),
      calls: this.calls,
      outcome,
    };
  }
}
