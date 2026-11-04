import { expect } from "@playwright/test";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";

type Policy = "baseline" | "linked-silence";
interface Item {
  id: number;
  filename: string;
  state: string;
}
interface Call {
  name: string;
  at: number;
  id?: number;
}
interface DownloadsGlobal {
  chrome: {
    downloads: {
      download: (options: { filename?: string }) => Promise<number>;
      search(query: object): Promise<Item[]>;
    };
    storage: { local: { set(value: object): Promise<void> } };
    alarms: { clear(name: string): Promise<boolean> };
    runtime: { sendMessage(message: unknown): Promise<{ ok: boolean; error?: string }> };
  };
  __e7?: {
    original: DownloadsGlobal["chrome"]["downloads"]["download"];
    calls: Call[];
    start: number;
  };
}

const kindOf = (name: string) =>
  name.endsWith("/presence.json")
    ? "presence"
    : /\/(offer|answer)-/.test(name)
      ? "signal"
      : "other";

export interface HistoryCounts {
  total: number;
  presence: number;
  signal: number;
  other: number;
}
const historyCounts = (items: Item[]): HistoryCounts => ({
  total: items.length,
  presence: items.filter((item) => kindOf(item.filename) === "presence").length,
  signal: items.filter((item) => kindOf(item.filename) === "signal").length,
  other: items.filter((item) => kindOf(item.filename) === "other").length,
});

/** Diagnostic observer on this profile's own worker; every attempted call is counted before Chrome answers. */
export async function meter(profile: DownloadsProfile, policy: Policy) {
  const before = await profile.serviceWorker.evaluate(async (mode) => {
    const held = globalThis as unknown as DownloadsGlobal;
    const { chrome } = held;
    await chrome.storage.local.set({ pocPresencePolicy: mode });
    const items = await chrome.downloads.search({});
    const original = chrome.downloads.download;
    const state = { original, calls: [] as Call[], start: Date.now() };
    held.__e7 = state;
    chrome.downloads.download = async (options) => {
      const call: Call = { name: options.filename ?? "", at: Date.now() };
      state.calls.push(call);
      const id = await original.call(chrome.downloads, options);
      call.id = id;
      return id;
    };
    return items;
  }, policy);
  return historyCounts(before);
}

/** Every retained history item, read through the profile that owns it, independently of the call counter. */
export async function measured(profile: DownloadsProfile) {
  const read = await profile.serviceWorker.evaluate(async () => {
    const held = globalThis as unknown as DownloadsGlobal;
    const state = held.__e7;
    if (!state) throw new Error("The E7 call counter was lost (worker restarted).");
    const items = await held.chrome.downloads.search({});
    return { calls: state.calls, windowMs: Date.now() - state.start, items };
  });
  const ids = new Set(read.items.map((item) => item.id));
  return {
    profile: profile.name,
    windowMs: read.windowMs,
    calls: read.calls.length,
    presenceCalls: read.calls.filter((call) => kindOf(call.name) === "presence").length,
    signalCalls: read.calls.filter((call) => kindOf(call.name) === "signal").length,
    otherCalls: read.calls.filter((call) => kindOf(call.name) === "other").length,
    erasedDuringWindow: read.calls.filter((call) => call.id !== undefined && !ids.has(call.id))
      .length,
    history: historyCounts(read.items),
    downloadsPerHour: (read.calls.length * 3_600_000) / read.windowMs,
  };
}

/** Reads Chrome's visible history list before cleanup; these small samples fit its first page. */
export async function visibleDownloads(profile: DownloadsProfile, count: number) {
  const page = await profile.context.newPage();
  try {
    await page.goto("chrome://downloads/");
    await expect(page.locator("downloads-item")).toHaveCount(count);
    return await page.locator("downloads-item").count();
  } finally {
    await page.close();
  }
}

/** Quiesces the alarm, then exercises the real offscreen stop and relay erase, retaining every presence item. */
export async function complete(profile: DownloadsProfile) {
  const items = await profile.serviceWorker.evaluate(async () => {
    const held = globalThis as unknown as DownloadsGlobal;
    await held.chrome.alarms.clear("poc-presence");
    const reply = await held.chrome.runtime.sendMessage({
      target: "offscreen",
      command: { type: "folder-stop" },
    });
    if (!reply.ok) throw new Error(reply.error ?? "folder-stop failed");
    if (!held.__e7) throw new Error("The E7 call counter was lost.");
    held.chrome.downloads.download = held.__e7.original;
    return held.chrome.downloads.search({});
  });
  const history = historyCounts(items);
  return { history, chromeDownloads: await visibleDownloads(profile, history.total) };
}
