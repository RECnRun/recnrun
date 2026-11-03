import { messageOf } from "@/background/probes/helpers";
import type { TargetInfo } from "@/background/probes/types";
import { RouteAEngine } from "@/background/route-a/engine";
import { RouteBEngine } from "@/background/route-b/engine";
import { SelectionEngine } from "@/background/selection/engine";
import { armTab, originOf, stopWorkers } from "@/background/lab/commands";
import type { Engines } from "@/background/lab/commands";
import { readPage } from "@/background/lab/pages";
import { labConfigOf } from "@/background/lab/schema";
import type { LabConfig } from "@/background/lab/schema";
import type {
  ArmedTab,
  CommandRecord,
  LabApis,
  LabJournal,
  LabLoaded,
  PageRecord,
} from "@/background/lab/types";

export interface LabOptions {
  now?: () => number;
  timeOrigin?: number;
  /** Runs the next journal comparison; tests drive `flush()` themselves. */
  schedule?: (task: () => void, ms: number) => void;
}

interface TabChange {
  url?: string;
  status?: string;
}

const byId = (a: TargetInfo, b: TargetInfo) => a.id.localeCompare(b.id);

/**
 * The strict lab's channel (E8): with no CDP client in the browser, the harness configures the
 * isolator through `chrome.storage.managed` and reads it from what it posts to `journalUrl`.
 */
export class LabChannel {
  readonly #apis: () => LabApis;
  readonly #now: () => number;
  readonly #timeOrigin: number;
  readonly #schedule: (task: () => void, ms: number) => void;
  readonly #engines: () => Engines;
  readonly #selection: SelectionEngine;
  #config: LabConfig | undefined;
  #ready: Promise<void> = Promise.resolve();
  readonly #tabs = new Map<number, Promise<void>>();
  readonly #armed = new Map<number, ArmedTab>();
  readonly #pages: PageRecord[] = [];
  readonly #commands: CommandRecord[] = [];
  readonly #errors: string[] = [];
  #targetsAtStart: TargetInfo[] = [];
  readonly #applied = { selection: "", stop: "" };
  #seq = 0;
  #posted = "";

  constructor(apis: () => LabApis, options: LabOptions = {}) {
    this.#apis = apis;
    this.#now = options.now ?? (() => performance.now());
    this.#timeOrigin = options.timeOrigin ?? performance.timeOrigin;
    this.#schedule = options.schedule ?? ((task, ms) => void setTimeout(task, ms));
    const debuggerApi = () => apis().debugger;
    const routeA = new RouteAEngine(debuggerApi, this.#now);
    const routeB = new RouteBEngine(debuggerApi, () => apis().extensionOrigin, this.#now);
    this.#engines = () => ({ api: apis().debugger, routeA, routeB, now: this.#now });
    this.#selection = new SelectionEngine(() => apis().selection, { now: this.#now });
  }

  /** Reads the managed value; without the lab key nothing here does anything. */
  start(): Promise<void> {
    this.#ready = this.#guardedBegin();
    return this.#ready;
  }

  /** `tabs.onUpdated`: arms a tab at its first loaded page of the origin, then reads each later page. */
  tabUpdated(tabId: number, change: TabChange, tab: { url?: string }): void {
    const previous = this.#tabs.get(tabId) ?? this.#ready;
    const next = previous
      .then(() => this.#onTab(tabId, change, tab.url ?? ""))
      .catch((error: unknown) => void this.#errors.push(messageOf(error)));
    this.#tabs.set(tabId, next);
  }

  /** `storage.onChanged` for the managed area: the first value, or a policy reload with the next command. */
  managedChanged(): Promise<void> {
    // Chrome can start a just-installed worker before it has filled the managed store.
    this.#ready = this.#ready.then(() =>
      this.#config === undefined ? this.#guardedBegin() : this.#reload(),
    );
    return this.#ready;
  }

  /** Posts the journal when it differs from the last one posted. */
  async flush(): Promise<boolean> {
    const config = this.#config;
    if (config === undefined) return false;
    const body = await this.#snapshot();
    const text = JSON.stringify(body);
    if (text === this.#posted) return false;
    const journal: LabJournal = {
      event: "journal",
      seq: this.#seq + 1,
      id: this.#apis().id,
      ...body,
    };
    await this.#apis().post(config.journalUrl, journal);
    this.#seq += 1;
    this.#posted = text;
    return true;
  }

  #guardedBegin(): Promise<void> {
    return this.#begin().catch((error: unknown) => {
      this.#config = undefined;
      this.#errors.push(messageOf(error));
    });
  }

  async #begin(): Promise<void> {
    const apis = this.#apis();
    const config = labConfigOf(await apis.managed.get());
    if (config === undefined) return;
    this.#config = config;
    // Before anything is armed: an attached target here belongs to another client.
    this.#targetsAtStart = (await apis.debugger.getTargets()).sort(byId);
    const loaded: LabLoaded = {
      event: "loaded",
      id: apis.id,
      version: apis.version,
      timeOrigin: this.#timeOrigin,
      targets: this.#targetsAtStart,
    };
    await apis.post(config.journalUrl, loaded);
    await this.#apply(config);
    this.#poll();
  }

  async #reload(): Promise<void> {
    try {
      const config = labConfigOf(await this.#apis().managed.get());
      if (config === undefined) return;
      this.#config = config;
      await this.#apply(config);
    } catch (error) {
      this.#errors.push(messageOf(error));
    }
  }

  async #apply(config: LabConfig): Promise<void> {
    const { selection, stop } = config;
    const key = JSON.stringify(selection ?? null);
    if (selection !== undefined && key !== this.#applied.selection) {
      this.#applied.selection = key;
      await this.#record(`select:${key}`, () => this.#selection.select(selection));
    }
    if (stop !== undefined && stop.id !== this.#applied.stop) {
      this.#applied.stop = stop.id;
      await this.#record(`stop:${stop.id}`, () => stopWorkers(this.#engines(), stop.origin));
    }
  }

  async #record(key: string, run: () => Promise<unknown>): Promise<void> {
    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      result = { error: messageOf(error) };
    }
    this.#commands.push({ key, at: this.#now(), result });
  }

  async #onTab(tabId: number, change: TabChange, url: string): Promise<void> {
    const arm = this.#config?.arm;
    if (arm === undefined || change.status !== "complete" || originOf(url) !== arm.origin) return;
    const armed = this.#armed.get(tabId);
    if (armed === undefined) {
      const prefix = this.#config?.marker ?? "lab";
      this.#armed.set(tabId, await armTab(this.#engines(), arm, { tabId, url, prefix }));
      return;
    }
    if (armed.error !== undefined) return;
    const page = { tabId, url, marker: armed.marker, at: this.#now() };
    this.#pages.push(await readPage(this.#apis(), page));
  }

  #poll(): void {
    const config = this.#config;
    if (config === undefined) return;
    const next = () =>
      void this.flush()
        .catch(() => undefined)
        .finally(() => this.#poll());
    this.#schedule(next, config.pollMs);
  }

  async #snapshot(): Promise<Omit<LabJournal, "event" | "seq" | "id">> {
    const { api, routeA, routeB } = this.#engines();
    return {
      timeOrigin: this.#timeOrigin,
      targetsAtStart: this.#targetsAtStart,
      targets: (await api.getTargets()).sort(byId),
      armed: [...this.#armed.values()],
      routeA: await routeA.journal(),
      routeB: await routeB.journal(),
      pages: this.#pages,
      commands: this.#commands,
      errors: this.#errors,
    };
  }
}
