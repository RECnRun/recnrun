import type { Worker } from "@playwright/test";

/** Milliseconds (service-worker clock) at which one reset's teardown steps were seen. */
export interface Teardown {
  /** RECnRun called `windows.remove` on the managed window. */
  removeCall?: number;
  /** `windows.onRemoved` fired. */
  removed?: number;
  /** Asked last of the `windows.getAll` samples that still listed an Incognito window. */
  windowLastSeen?: number;
  /** Answered first of the `windows.getAll` samples that listed no Incognito window. */
  noWindow?: number;
  /** Asked last of the `cookies.getAllCookieStores` samples that still listed every store. */
  storeLastSeen?: number;
  /** Answered first of the samples with fewer stores; only with the `cookies` permission. */
  storeGone?: number;
  /** RECnRun called `windows.create` for the next Incognito window. */
  createCall?: number;
  /** `windows.onCreated` fired for it. */
  created?: number;
}

interface ProbeWindow {
  id?: number;
  incognito: boolean;
}

interface ProbeGlobal {
  teardown?: Teardown;
  teardownProbe?: boolean;
  chrome: {
    windows: {
      remove(windowId: number): Promise<void>;
      create(data?: { incognito?: boolean }): Promise<ProbeWindow>;
      getAll(filter: object): Promise<ProbeWindow[]>;
      onRemoved: { addListener(listener: (windowId: number) => void): void };
      onCreated: { addListener(listener: (window: ProbeWindow) => void): void };
    };
    cookies?: { getAllCookieStores(): Promise<unknown[]> };
  };
}

/**
 * Watches the extension's own calls and Chrome's window events from inside the service worker,
 * recording times only, never a value. It observes; the reset itself is RECnRun's.
 */
export function installTeardownProbe(serviceWorker: Worker): Promise<void> {
  return serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as ProbeGlobal;
    scope.teardown = {};
    if (scope.teardownProbe === true) return;
    scope.teardownProbe = true;
    const { windows, cookies } = scope.chrome;
    const now = () => performance.now();
    const mark = (step: keyof Teardown, at = now()) => {
      if (scope.teardown && scope.teardown[step] === undefined) scope.teardown[step] = at;
    };
    // Only until the matching step is gone, so the next window's arrival does not move it.
    const seen = (step: keyof Teardown, gone: keyof Teardown, at: number) => {
      if (scope.teardown && scope.teardown[gone] === undefined) scope.teardown[step] = at;
    };
    const sampleWindows = async () => {
      const asked = now();
      const open = await windows.getAll({});
      if (open.some((each) => each.incognito)) seen("windowLastSeen", "noWindow", asked);
      else mark("noWindow");
    };
    // Without the `cookies` permission there is no store to count, so the store steps stay unset.
    const storeCount = async () => (await cookies?.getAllCookieStores())?.length ?? 0;
    const sampleStores = async (before: number) => {
      const asked = now();
      if ((await storeCount()) < before) mark("storeGone");
      else if (before > 0) seen("storeLastSeen", "storeGone", asked);
    };
    // Samples until the next window is created, so each transition is bracketed in order.
    const watch = async () => {
      const stores = await storeCount();
      for (let sample = 0; sample < 5000 && scope.teardown?.created === undefined; sample += 1) {
        await sampleWindows();
        await sampleStores(stores);
      }
    };
    const remove = windows.remove.bind(windows);
    windows.remove = (windowId) => {
      mark("removeCall");
      void watch();
      return remove(windowId);
    };
    const create = windows.create.bind(windows);
    windows.create = (data) => {
      if (data?.incognito === true) mark("createCall");
      return create(data);
    };
    windows.onRemoved.addListener(() => mark("removed"));
    windows.onCreated.addListener((window) => {
      if (window.incognito) mark("created");
    });
  });
}

/** What the probe saw since it was installed or last read; reading starts the next record. */
export function readTeardown(serviceWorker: Worker): Promise<Teardown> {
  return serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as ProbeGlobal;
    const seen = scope.teardown ?? {};
    scope.teardown = {};
    return seen;
  });
}

const between = (from: number | undefined, to: number | undefined) =>
  from === undefined || to === undefined ? undefined : Math.round((to - from) * 100) / 100;

/** The gaps the POC report quotes, in milliseconds, plus the order in which the steps came. */
export function teardownGaps(seen: Teardown) {
  const order = (Object.keys(seen) as (keyof Teardown)[]).sort(
    (a, b) => (seen[a] ?? 0) - (seen[b] ?? 0),
  );
  return {
    closeToRemoved: between(seen.removeCall, seen.removed),
    closeToWindowLastSeen: between(seen.removeCall, seen.windowLastSeen),
    closeToNoWindow: between(seen.removeCall, seen.noWindow),
    closeToStoreLastSeen: between(seen.removeCall, seen.storeLastSeen),
    closeToStoreGone: between(seen.removeCall, seen.storeGone),
    storeGoneToCreate: between(seen.storeGone, seen.createCall),
    removedToCreate: between(seen.removed, seen.createCall),
    createToCreated: between(seen.createCall, seen.created),
    order: order.join(" < "),
  };
}

/** Minimum, median, 95th percentile, and maximum of the defined values. */
export function spread(values: readonly (number | undefined)[]) {
  const sorted = values.filter((each) => each !== undefined).sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
  };
}
