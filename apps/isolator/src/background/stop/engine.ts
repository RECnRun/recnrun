import { parseMarker } from "@recnrun/isolation-core";
import { clientExpression, UNREGISTER } from "@/background/stop/expressions";
import { Recorder } from "@/background/stop/recorder";
import type { Outcome } from "@/background/stop/recorder";
import {
  ClientRequest,
  CloseRequest,
  OriginRequest,
  parse,
  TabRequest,
  TargetRequest,
  WatchRequest,
} from "@/background/stop/requests";
import { blockScope, evaluateOnTab, unblock } from "@/background/stop/scope";
import type { Clock, Stop, StopApis, StopJournal, WatchJournal } from "@/background/stop/types";
import { Watcher } from "@/background/stop/watch";
import { closeTarget, pauseHold, release, terminateExecution } from "@/background/stop/worker";

const PERFORMANCE: Clock = { now: () => performance.now(), timeOrigin: performance.timeOrigin };

interface Watching {
  watcher: Watcher;
  recorder: Recorder;
  marker?: string;
}

/** Stop and restart control (POC PLAN.md P1.3): every mechanism the extension has, journaled. */
export class StopEngine implements Stop {
  readonly #apis: () => StopApis;
  readonly #clock: Clock;
  readonly #holds = new Map<string, Promise<Outcome<Record<string, unknown>>>>();
  #watching: Watching | undefined;

  constructor(apis: () => StopApis, clock: Clock = PERFORMANCE) {
    this.#apis = apis;
    this.#clock = clock;
  }

  async closeTarget(request: unknown): Promise<StopJournal> {
    const parsed = parse(CloseRequest, request);
    const recorder = this.#recorder();
    return recorder.journal("close-target", await closeTarget(recorder, parsed));
  }

  async terminateExecution(request: unknown): Promise<StopJournal> {
    const { targetId } = parse(TargetRequest, request);
    const recorder = this.#recorder();
    return recorder.journal("terminate-execution", await terminateExecution(recorder, targetId));
  }

  async pauseHold(request: unknown): Promise<StopJournal> {
    const { targetId } = parse(TargetRequest, request);
    if (this.#holds.has(targetId)) throw new Error(`${targetId} is already held`);
    const recorder = this.#recorder();
    const { outcome, evaluation } = await pauseHold(recorder, targetId);
    this.#holds.set(targetId, evaluation);
    return recorder.journal("pause-hold", outcome);
  }

  async release(request: unknown): Promise<StopJournal> {
    const { targetId } = parse(TargetRequest, request);
    const evaluation = this.#holds.get(targetId);
    if (!evaluation) throw new Error(`${targetId} is not held`);
    this.#holds.delete(targetId);
    const recorder = this.#recorder();
    return recorder.journal("release", await release(recorder, targetId, evaluation));
  }

  async blockScope(request: unknown): Promise<StopJournal> {
    const { origin } = parse(OriginRequest, request);
    const recorder = this.#recorder();
    return recorder.journal("dnr-block-evict", await blockScope(recorder, origin));
  }

  async unblock(): Promise<StopJournal> {
    const recorder = this.#recorder();
    return recorder.journal("unblock", await unblock(recorder));
  }

  async unregister(request: unknown): Promise<StopJournal> {
    const { tabId } = parse(TabRequest, request);
    const recorder = this.#recorder();
    return recorder.journal("unregister", await evaluateOnTab(recorder, tabId, UNREGISTER));
  }

  async client(request: unknown): Promise<StopJournal> {
    const parsed = parse(ClientRequest, request);
    const recorder = this.#recorder();
    const outcome = await evaluateOnTab(recorder, parsed.tabId, clientExpression(parsed));
    return recorder.journal(`client:${parsed.action}`, outcome);
  }

  watch(request: unknown): WatchJournal {
    const { marker } = parse(WatchRequest, request);
    if (this.#watching) throw new Error("already watching; call unwatch() first");
    const checked = marker === undefined ? undefined : parseMarker(marker);
    const recorder = this.#recorder();
    this.#watching = {
      watcher: new Watcher(recorder, checked),
      recorder,
      ...(checked ? { marker: checked } : {}),
    };
    return this.#watchJournal(this.#watching);
  }

  async unwatch(): Promise<WatchJournal> {
    const watching = this.#watching;
    if (!watching) throw new Error("not watching");
    this.#watching = undefined;
    await watching.watcher.stop();
    return this.#watchJournal(watching);
  }

  #recorder(): Recorder {
    return new Recorder(this.#apis(), this.#clock);
  }

  #watchJournal({ watcher, recorder, marker }: Watching): WatchJournal {
    return {
      timeOrigin: this.#clock.timeOrigin,
      ...(marker === undefined ? {} : { marker }),
      events: watcher.events,
      calls: recorder.calls,
    };
  }
}
