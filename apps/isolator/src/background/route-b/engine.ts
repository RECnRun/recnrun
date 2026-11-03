import { BOOTSTRAP_HASH, BOOTSTRAP_VERSION } from "@recnrun/worker-bootstrap";
import { isAttachedEvent } from "@/background/probes/auto-attach";
import type { AttachedEvent } from "@/background/probes/auto-attach";
import { messageOf, PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import {
  isLoopbackUrl,
  armablePage,
  loopbackPage,
  loopbackTargetOf,
  REFUSED,
} from "@/background/probes/loopback";
import type { Debuggee, DebuggerApi, EventListener } from "@/background/probes/types";
import { AUTO_ATTACH, command } from "@/background/route-a/attached";
import { MODULE_BOOTSTRAP_PATH } from "@/background/route-b/module-resource";
import { NetworkLog } from "@/background/route-b/network";
import { handlePaused, pausedEntryOf, pausedEventOf } from "@/background/route-b/paused";
import type { PausedContext } from "@/background/route-b/paused";
import { armRequestOf, tabIdOf, targetIdOf } from "@/background/route-b/requests";
import type { ArmRequest } from "@/background/route-b/requests";
import { FETCHED_PATTERN } from "@/background/route-b/select";
import type {
  PausedEntry,
  RouteB,
  RouteBJournal,
  UpdateOutcome,
  WorkerEntry,
} from "@/background/route-b/types";
import { updateInPage } from "@/background/route-b/update";

/** Targets whose scripts Route B intercepts on their own session. */
const WORKER_TYPES = new Set(["service_worker", "worker", "shared_worker"]);

interface Armed {
  request: ArmRequest;
  listener: EventListener;
  fetchEnable: string;
}

/** `ok`, or Chrome's exact error: Route B records a refused enable instead of failing on it. */
async function attempt(
  api: DebuggerApi,
  target: Debuggee,
  method: string,
  params?: Record<string, unknown>,
) {
  try {
    await command(api, target, method, params);
    return "ok";
  } catch (error) {
    return messageOf(error);
  }
}

function enableFetch(api: DebuggerApi, target: Debuggee, request: ArmRequest) {
  // E6's fetch-import answers the selection path, which the harness's pattern does not name.
  const extra = request.selection === "fetch-import" ? [FETCHED_PATTERN] : [];
  const patterns = [request.urlPattern, ...extra].map((urlPattern) => ({
    urlPattern,
    requestStage: "Response",
  }));
  return attempt(api, target, "Fetch.enable", { patterns });
}

/** Route B (POC PLAN.md P1.4): Chrome fetches the worker's script and Route B fulfills it wrapped. */
export class RouteBEngine implements RouteB {
  readonly #debuggerApi: () => DebuggerApi;
  readonly #extensionOrigin: () => string;
  readonly #now: () => number;
  #workers: WorkerEntry[] = [];
  #paused: PausedEntry[] = [];
  readonly #network = new NetworkLog();
  readonly #pending = new Set<Promise<void>>();
  readonly #armed = new Map<number, Armed>();

  constructor(
    debuggerApi: () => DebuggerApi,
    extensionOrigin: () => string,
    now: () => number = () => performance.now(),
  ) {
    this.#debuggerApi = debuggerApi;
    this.#extensionOrigin = extensionOrigin;
    this.#now = now;
  }

  async arm(request: unknown): Promise<{ fetchEnable: string }> {
    const armRequest = armRequestOf(request);
    const { tabId } = armRequest;
    if (this.#armed.has(tabId)) throw new Error(`tab ${tabId} is already armed`);
    const api = this.#debuggerApi();
    armablePage(await api.getTargets(), tabId);
    const armed: Armed = {
      request: armRequest,
      listener: this.#listenerFor(armRequest),
      fetchEnable: "skipped",
    };
    // Listening first: auto-attach reports the targets that already exist right away.
    api.onEvent.addListener(armed.listener);
    this.#armed.set(tabId, armed);
    try {
      await withTimeout(api.attach({ tabId }, PROTOCOL_VERSION), "attach");
      if (armRequest.tabFetch) armed.fetchEnable = await enableFetch(api, { tabId }, armRequest);
      await command(api, { tabId }, "Target.setAutoAttach", AUTO_ATTACH);
    } catch (error) {
      await this.#release(tabId);
      throw error;
    }
    return { fetchEnable: armed.fetchEnable };
  }

  async journal(): Promise<RouteBJournal> {
    await Promise.allSettled(this.#pending);
    const tabs = [...this.#armed].map(([tabId, { request, fetchEnable }]) => ({
      tabId,
      marker: request.marker,
      fetchEnable,
    }));
    return {
      bootstrap: { hash: BOOTSTRAP_HASH, version: BOOTSTRAP_VERSION },
      tabs,
      workers: this.#workers.map((entry) => ({ ...entry })),
      paused: this.#paused.map((entry) => ({ ...entry })),
      network: this.#network.entries(),
    };
  }

  async disarm(request: unknown): Promise<RouteBJournal> {
    const tabId = this.#armedTab(request);
    const journal = await this.journal();
    await this.#release(tabId);
    this.#workers = [];
    this.#paused = [];
    this.#network.clear();
    return journal;
  }

  async update(request: unknown): Promise<UpdateOutcome> {
    const tabId = this.#armedTab(request);
    const api = this.#debuggerApi();
    // The armed tab may have navigated away from the loopback since arm.
    loopbackPage(await api.getTargets(), tabId);
    return updateInPage(api, { tabId });
  }

  async stopWorker(request: unknown): Promise<{ success: boolean }> {
    const targetId = targetIdOf(request);
    const api = this.#debuggerApi();
    loopbackTargetOf(await api.getTargets(), targetId);
    const target = { targetId };
    await withTimeout(api.attach(target, PROTOCOL_VERSION), "attach");
    try {
      const { success } = await command(api, target, "Target.closeTarget", { targetId });
      return { success: success === true };
    } finally {
      await withTimeout(api.detach(target), "detach").catch(() => undefined);
    }
  }

  #armedTab(request: unknown): number {
    const tabId = tabIdOf(request);
    if (!this.#armed.has(tabId)) throw new Error(`tab ${tabId} is not armed`);
    return tabId;
  }

  #listenerFor(request: ArmRequest): EventListener {
    return (source, method, params) => {
      if (source.tabId !== request.tabId) return;
      if (method === "Target.attachedToTarget" && isAttachedEvent(params)) {
        this.#track(this.#onAttached(source, params, request));
      } else if (method === "Fetch.requestPaused") {
        this.#onPaused(source, params, request);
      } else if (request.network) {
        this.#network.record(source, method, params);
      }
    };
  }

  #onPaused(source: Debuggee, params: unknown, request: ArmRequest): void {
    const event = pausedEventOf(params);
    if (event === undefined) return;
    const entry = pausedEntryOf(source, event, this.#now());
    this.#paused.push(entry);
    this.#track(handlePaused(this.#context(request), source, entry, event));
  }

  #context(request: ArmRequest): PausedContext {
    const moduleUrl = `${this.#extensionOrigin()}${MODULE_BOOTSTRAP_PATH}`;
    const extensionOrigin = this.#extensionOrigin();
    return { api: this.#debuggerApi(), request, moduleUrl, extensionOrigin, now: this.#now };
  }

  #track(handled: Promise<void>): void {
    this.#pending.add(handled);
    void handled.finally(() => this.#pending.delete(handled));
  }

  /**
   * Enables Fetch (and Network when asked) on a worker's session while it waits, then releases it;
   * a target outside the loopback (R11) is only released.
   */
  async #onAttached(source: Debuggee, event: AttachedEvent, request: ArmRequest): Promise<void> {
    const { sessionId, waitingForDebugger, targetInfo } = event;
    const inside = isLoopbackUrl(targetInfo.url);
    const entry: WorkerEntry = {
      sessionId,
      targetId: targetInfo.targetId,
      type: targetInfo.type,
      url: targetInfo.url,
      waitingForDebugger,
      attachedAt: this.#now(),
      fetchEnable: inside ? "skipped" : REFUSED,
      networkEnable: inside ? "skipped" : REFUSED,
      released: false,
    };
    this.#workers.push(entry);
    const api = this.#debuggerApi();
    const session = { tabId: source.tabId, sessionId };
    const worker = inside && WORKER_TYPES.has(entry.type);
    if (worker && request.workerFetch) {
      entry.fetchEnable = await enableFetch(api, session, request);
    }
    // A paused worker answers Network.enable only once it runs, so the reply is awaited after release.
    const network = worker && request.network ? attempt(api, session, "Network.enable") : undefined;
    if (waitingForDebugger) await this.#releaseWorker(api, session, entry);
    if (network) entry.networkEnable = await network;
  }

  async #releaseWorker(api: DebuggerApi, session: Debuggee, entry: WorkerEntry): Promise<void> {
    try {
      await command(api, session, "Runtime.runIfWaitingForDebugger");
      entry.released = true;
    } catch (error) {
      entry.error = messageOf(error);
    }
  }

  async #release(tabId: number): Promise<void> {
    const api = this.#debuggerApi();
    const armed = this.#armed.get(tabId);
    if (armed) api.onEvent.removeListener(armed.listener);
    this.#armed.delete(tabId);
    await withTimeout(api.detach({ tabId }), "detach").catch(() => undefined);
  }
}
