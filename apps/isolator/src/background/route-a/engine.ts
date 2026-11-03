import { parseMarker } from "@recnrun/isolation-core";
import { BOOTSTRAP_HASH, BOOTSTRAP_VERSION } from "@recnrun/worker-bootstrap";
import { isAttachedEvent } from "@/background/probes/auto-attach";
import { PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import { isLoopbackUrl } from "@/background/probes/loopback";
import type { Debuggee, DebuggerApi, EventListener, TargetInfo } from "@/background/probes/types";
import {
  AUTO_ATTACH,
  bootstrap,
  command,
  entryOf,
  handleAttached,
} from "@/background/route-a/attached";
import { ChildSessions } from "@/background/route-a/children";
import { closeTarget } from "@/background/route-a/close";
import { EVENT_LIMIT, detachEventOf, targetEventOf } from "@/background/route-a/events";
import { handlePaused, prepareAndRelease } from "@/background/route-a/pause";
import { armRequestOf, tabIdOf, targetIdOf, watchRequestOf } from "@/background/route-a/requests";
import { TargetWatch } from "@/background/route-a/watch";
import type {
  CloseReport,
  DetachRecord,
  JournalEntry,
  RouteA,
  RouteAJournal,
  TargetEvent,
  UnattachedTarget,
  WatchReport,
} from "@/background/route-a/types";

/** What `Storage.clearDataForOrigin` removes between iterations: registrations and their storage. */
const CLEARED_STORAGE = "service_workers,indexeddb,cache_storage";

function originOf(url: string): string | undefined {
  const origin = URL.canParse(url) ? new URL(url).origin : "null";
  return origin === "null" ? undefined : origin;
}

function pageOf(targets: TargetInfo[], tabId: number): TargetInfo {
  const page = targets.find((target) => target.type === "page" && target.tabId === tabId);
  if (!page) throw new Error(`no tab ${tabId}`);
  return page;
}

/** Route A (POC PLAN.md P1.1): the tab's debugger session auto-attaches workers paused. */
export class RouteAEngine implements RouteA {
  readonly #debuggerApi: () => DebuggerApi;
  readonly #now: () => number;
  #marker: string | undefined;
  #entries: JournalEntry[] = [];
  #events: TargetEvent[] = [];
  #eventsDropped = 0;
  readonly #children = new ChildSessions();
  readonly #pending = new Set<Promise<void>>();
  readonly #armed = new Map<number, EventListener>();
  readonly #direct = new Set<string>();
  #watch: TargetWatch | undefined;
  #detachListening = false;
  #tabDetached: DetachRecord | undefined;

  constructor(debuggerApi: () => DebuggerApi, now: () => number = () => performance.now()) {
    this.#debuggerApi = debuggerApi;
    this.#now = now;
  }

  setMarker(marker: unknown): string {
    this.#marker = parseMarker(marker);
    return this.#marker;
  }

  async arm(request: unknown): Promise<void> {
    const { tabId, pauseBeforeScript } = armRequestOf(request);
    this.#requireMarker();
    if (this.#armed.has(tabId)) throw new Error(`tab ${tabId} is already armed`);
    const api = this.#debuggerApi();
    this.#listenForDetach(api);
    const listener = this.#listenerFor(tabId, pauseBeforeScript);
    // Listening first: auto-attach reports the targets that already exist right away.
    api.onEvent.addListener(listener);
    this.#armed.set(tabId, listener);
    try {
      await withTimeout(api.attach({ tabId }, PROTOCOL_VERSION), "attach");
      await command(api, { tabId }, "Target.setAutoAttach", AUTO_ATTACH);
    } catch (error) {
      await this.#release(tabId);
      throw error;
    }
  }

  async journal(): Promise<RouteAJournal> {
    await Promise.allSettled(this.#pending);
    const unattached = await this.#unattached([...this.#armed.keys()]);
    return {
      ...(this.#marker === undefined ? {} : { marker: this.#marker }),
      bootstrap: { hash: BOOTSTRAP_HASH, version: BOOTSTRAP_VERSION },
      entries: this.#entries.map((entry) => ({ ...entry })),
      unattached,
      events: this.#events.map((event) => ({ ...event })),
      ...(this.#eventsDropped === 0 ? {} : { eventsDropped: this.#eventsDropped }),
      ...(this.#tabDetached === undefined ? {} : { tabDetached: { ...this.#tabDetached } }),
    };
  }

  async disarm(request: unknown): Promise<RouteAJournal> {
    const tabId = tabIdOf(request);
    if (!this.#armed.has(tabId)) throw new Error(`tab ${tabId} is not armed`);
    const journal = await this.journal();
    await this.#release(tabId);
    const api = this.#debuggerApi();
    for (const targetId of this.#direct) {
      await withTimeout(api.detach({ targetId }), "detach").catch(() => undefined);
    }
    this.#direct.clear();
    this.#entries = [];
    this.#events = [];
    this.#eventsDropped = 0;
    this.#tabDetached = undefined;
    return journal;
  }

  async attachTarget(request: unknown): Promise<JournalEntry> {
    const targetId = targetIdOf(request);
    const marker = this.#requireMarker();
    const api = this.#debuggerApi();
    this.#listenForDetach(api);
    const target = (await api.getTargets()).find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`no target ${targetId}`);
    const entry: JournalEntry = {
      sessionId: "",
      targetId,
      type: target.type,
      url: target.url,
      waitingForDebugger: false,
      attachedAt: this.#now(),
      marker,
      released: false,
    };
    this.#entries.push(entry);
    await withTimeout(api.attach({ targetId }, PROTOCOL_VERSION), "attach");
    this.#direct.add(targetId);
    await bootstrap(api, { targetId }, entry, this.#now);
    return { ...entry };
  }

  async watch(request: unknown): Promise<{ intervalMs: number; staleSkipped: number }> {
    const parsed = watchRequestOf(request);
    if (this.#watch) throw new Error("already watching");
    const watch = new TargetWatch(this.#debuggerApi(), parsed, this.#now);
    this.#watch = watch;
    return watch.start().catch((error: unknown) => {
      this.#watch = undefined;
      throw error;
    });
  }

  async unwatch(): Promise<WatchReport> {
    const watch = this.#watch;
    if (!watch) throw new Error("not watching");
    this.#watch = undefined;
    return watch.stop();
  }

  async closeTarget(request: unknown): Promise<CloseReport> {
    const options = { now: this.#now, children: this.#children };
    return closeTarget(this.#debuggerApi(), targetIdOf(request), options);
  }

  async clearOrigin(request: unknown): Promise<{ origin: string }> {
    const tabId = tabIdOf(request);
    const api = this.#debuggerApi();
    const { url } = pageOf(await api.getTargets(), tabId);
    const origin = originOf(url);
    // R11: the isolator never touches the data of a site outside the loopback.
    if (origin === undefined || !isLoopbackUrl(origin)) {
      throw new Error(`refuses to clear ${origin ?? url}, which is not on the loopback`);
    }
    const tab: Debuggee = { tabId };
    const borrowed = !this.#armed.has(tabId);
    if (borrowed) await withTimeout(api.attach(tab, PROTOCOL_VERSION), "attach");
    try {
      await command(api, tab, "Storage.clearDataForOrigin", {
        origin,
        storageTypes: CLEARED_STORAGE,
      });
    } finally {
      if (borrowed) await withTimeout(api.detach(tab), "detach").catch(() => undefined);
    }
    return { origin };
  }

  async tabs(): Promise<{ tabId: number; url: string }[]> {
    const targets = await this.#debuggerApi().getTargets();
    return targets.flatMap(({ type, tabId, url }) =>
      type === "page" && tabId !== undefined ? [{ tabId, url }] : [],
    );
  }

  /** One `onDetach` listener, added at the first attach since the getter defers to call time. */
  #listenForDetach(api: DebuggerApi): void {
    if (this.#detachListening) return;
    this.#detachListening = true;
    api.onDetach.addListener((source, reason) =>
      this.#detached(source, { reason, at: this.#now() }),
    );
  }

  /** Records a detach of an armed tab or a direct target; any other session is not Route A's. */
  #detached(source: Debuggee, record: DetachRecord): void {
    this.#record(detachEventOf(source, record));
    const { tabId, targetId } = source;
    if (tabId !== undefined && this.#armed.has(tabId)) this.#tabDetached = record;
    if (targetId === undefined || !this.#direct.has(targetId)) return;
    for (const entry of this.#entries) {
      if (entry.targetId === targetId && entry.sessionId === "") entry.detached = { ...record };
    }
  }

  #requireMarker(): string {
    if (this.#marker === undefined) throw new Error("call setMarker() first");
    return this.#marker;
  }

  #listenerFor(tabId: number, pauseBeforeScript: boolean): EventListener {
    return (source, method, params) => {
      if (source.tabId !== tabId || this.#marker === undefined) return;
      const event = this.#targetEvent(source, method, params);
      if (method === "Target.attachedToTarget" && isAttachedEvent(params)) {
        const entry = entryOf(source, params, event?.at ?? this.#now(), this.#marker);
        this.#children.add(source, entry.sessionId, entry.targetId);
        this.#entries.push(entry);
        this.#track(this.#handle(source, entry, pauseBeforeScript));
      } else if (method === "Debugger.paused") {
        const entry = this.#entries.find(
          (item) => item.pause && item.sessionId === source.sessionId,
        );
        const api = this.#debuggerApi();
        if (entry) this.#track(handlePaused(api, source, entry, { params, now: this.#now }));
      }
    };
  }

  #record(event: TargetEvent): void {
    this.#events.push(event);
    if (this.#events.length <= EVENT_LIMIT) return;
    this.#events.shift();
    this.#eventsDropped += 1;
  }

  /** Journals a Target event and forgets a child session Chrome detached. */
  #targetEvent(source: Debuggee, method: string, params: unknown): TargetEvent | undefined {
    const event = targetEventOf(source, method, params, this.#now);
    if (event) this.#record(event);
    if (method === "Target.detachedFromTarget" && event?.sessionId) {
      this.#children.remove(event.sessionId);
    }
    return event;
  }

  /** With `pauseBeforeScript`, a waiting worker gets its bootstrap at the instrumentation pause. */
  #handle(source: Debuggee, entry: JournalEntry, pauseBeforeScript: boolean): Promise<void> {
    const api = this.#debuggerApi();
    const pauses = pauseBeforeScript && entry.marker !== undefined && entry.waitingForDebugger;
    return pauses
      ? prepareAndRelease(api, source, entry)
      : handleAttached(api, source, entry, this.#now);
  }

  #track(handled: Promise<void>): void {
    this.#pending.add(handled);
    void handled.finally(() => this.#pending.delete(handled));
  }

  /** Stops listening for the tab and detaches it; Chrome drops its flattened child sessions too. */
  async #release(tabId: number): Promise<void> {
    const api = this.#debuggerApi();
    const listener = this.#armed.get(tabId);
    if (listener) api.onEvent.removeListener(listener);
    this.#armed.delete(tabId);
    this.#children.dropTab(tabId);
    await withTimeout(api.detach({ tabId }), "detach").catch(() => undefined);
  }

  /** Worker targets on an armed tab's origin that no auto-attach or direct attach reached. */
  async #unattached(tabIds: number[]): Promise<UnattachedTarget[]> {
    if (tabIds.length === 0) return [];
    const targets = await this.#debuggerApi().getTargets();
    const pages = targets.filter((target) => target.type === "page");
    const origins = new Set(
      pages.filter((page) => tabIds.includes(page.tabId ?? -1)).map((page) => originOf(page.url)),
    );
    origins.delete(undefined);
    const seen = new Set(this.#entries.map((entry) => entry.targetId));
    return targets
      .filter((target) => target.type !== "page" && !seen.has(target.id))
      .filter((target) => origins.has(originOf(target.url)))
      .map(({ id, type, url }) => ({ targetId: id, type, url }));
  }
}
