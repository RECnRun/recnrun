import { describe, expect, test } from "vite-plus/test";
import { createProbeHarness, exposeProbes, HARNESS_GLOBAL } from "@/background/probes/expose";
import type { ProbeHarness } from "@/background/probes/expose";
import { createContext, PROBES, runAllProbes, runProbes } from "@/background/probes/runner";
import type {
  Debuggee,
  DebuggerApi,
  DetachListener,
  EventListener,
  ProbeResult,
  ProbeTargets,
  TargetInfo,
} from "@/background/probes/types";

const ORIGIN = "http://app.test";
const URLS: ProbeTargets = {
  pageUrl: `${ORIGIN}/workers.html`,
  serviceWorkerUrl: `${ORIGIN}/sw-main.js`,
  sharedWorkerUrl: `${ORIGIN}/shared-worker.js`,
  dedicatedWorkerUrl: `${ORIGIN}/worker.js`,
  iframeUrl: "http://idp.test/whoami",
  cookieUrl: `${ORIGIN}/`,
};
const NOT_ALLOWED = '{"code":-32000,"message":"Not allowed"}';
const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: URLS.pageUrl, attached: false, tabId: 7 },
  { type: "worker", id: "sw", url: `${URLS.serviceWorkerUrl}?variant=classic`, attached: false },
  { type: "worker", id: "shared", url: `${URLS.sharedWorkerUrl}?type=classic`, attached: false },
];
const noWait = async () => undefined;

function listeners<T>() {
  const set = new Set<T>();
  return { set, addListener: (l: T) => set.add(l), removeListener: (l: T) => set.delete(l) };
}

/** A fake chrome.debugger: answers every command, refuses ServiceWorker.*, auto-attaches workers. */
function fakeDebugger(refused: Record<string, string> = { "ServiceWorker.enable": NOT_ALLOWED }) {
  const onEvent = listeners<EventListener>();
  const onDetach = listeners<DetachListener>();
  const sent: { target: Debuggee; method: string }[] = [];
  const emit = (source: Debuggee, method: string, params?: object) =>
    onEvent.set.forEach((listener) => listener(source, method, params));
  const attachEvents = (source: Debuggee) => {
    for (const [type, url] of [
      ["worker", `${URLS.dedicatedWorkerUrl}?type=classic`],
      ["shared_worker", `${URLS.sharedWorkerUrl}?type=classic`],
      // Chrome reports a waiting iframe with an empty URL.
      ["iframe", ""],
    ]) {
      const targetInfo = { targetId: `${type}-new`, type, url };
      emit(source, "Target.attachedToTarget", {
        sessionId: `s-${type}`,
        targetInfo,
        waitingForDebugger: true,
      });
    }
  };
  const api: DebuggerApi = {
    getTargets: async () => TARGETS,
    attach: async () => undefined,
    detach: async (target) =>
      onDetach.set.forEach((listener) => listener(target, "canceled_by_user")),
    sendCommand: async (target, method) => {
      sent.push({ target, method });
      const error = refused[method];
      if (error) throw new Error(error);
      if (method === "Page.reload") attachEvents(target);
      if (method === "Debugger.pause") emit(target, "Debugger.paused");
      if (method === "Target.getTargets")
        return { targetInfos: [{ type: "page", url: URLS.pageUrl }] };
      if (method === "Network.setCookie") return { success: true };
      return {};
    },
    onEvent,
    onDetach,
  };
  return { api, sent, onEvent, onDetach };
}

function byId(results: ProbeResult[]): Record<string, ProbeResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("the probe table", () => {
  test("has unique ids, each with a description", () => {
    const ids = PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROBES.every((probe) => probe.description.length > 0)).toBe(true);
  });

  test("the runner returns one result per probe, in order", async () => {
    const { api } = fakeDebugger();
    const results = await runAllProbes(api, URLS, noWait);
    expect(results.map((result) => result.id)).toEqual(PROBES.map((probe) => probe.id));
  });

  test("a throwing probe becomes rejected with its message, and the next one still runs", async () => {
    const probes = [
      { id: "boom", description: "throws", run: async () => Promise.reject(new Error("refused")) },
      { id: "fine", description: "allowed", run: async () => ({ status: "allowed" as const }) },
    ];
    const context = createContext(fakeDebugger().api, URLS, noWait);
    expect(await runProbes(probes, context)).toEqual([
      { id: "boom", status: "rejected", error: "refused" },
      { id: "fine", status: "allowed" },
    ]);
  });
});

describe("a run against a fake chrome.debugger", () => {
  test("records listed targets, refusals with Chrome's exact text, and auto-attached targets", async () => {
    const { api, onEvent, onDetach } = fakeDebugger();
    const results = byId(await runAllProbes(api, URLS, noWait));
    expect(results["get-targets-service-worker"]).toMatchObject({
      status: "allowed",
      detail: { type: "worker" },
    });
    expect(results["get-targets-dedicated-worker"]).toMatchObject({ status: "rejected" });
    expect(results["get-targets-dedicated-worker"]?.error).toMatch(
      /^not listed .*types listed: page, worker/,
    );
    expect(results["service-worker-enable"]).toEqual({
      id: "service-worker-enable",
      status: "rejected",
      error: NOT_ALLOWED,
    });
    expect(results["worker-service-worker-enable"]).toMatchObject({
      status: "rejected",
      error: NOT_ALLOWED,
    });
    for (const name of ["dedicated-worker", "shared-worker", "iframe"]) {
      expect(results[`auto-attach-${name}`], name).toMatchObject({ status: "allowed" });
    }
    expect(results["auto-attach-service-worker"]).toMatchObject({ status: "rejected" });
    expect(results["run-if-waiting-for-debugger"]).toMatchObject({ status: "allowed" });
    expect(results["attach-dedicated-worker"]).toMatchObject({
      status: "allowed",
      detail: { targetId: "worker-new" },
    });
    expect(results["tab-target-get-targets"]).toMatchObject({ detail: { browserWide: false } });
    expect(results["network-set-cookie"]).toMatchObject({ detail: { success: true } });
    expect(results["worker-debugger-pause"]).toMatchObject({
      detail: { pausedEventArrived: true },
    });
    expect(results["worker-close-target"]).toMatchObject({ detail: { listedAfter: true } });
    expect(results.cleanup).toMatchObject({ status: "allowed" });
    expect(onEvent.set.size + onDetach.set.size).toBe(0);
  });

  test("marks worker probes unavailable when no fixture target is listed", async () => {
    const { api } = fakeDebugger();
    api.getTargets = async () => [];
    const results = byId(await runAllProbes(api, URLS, noWait));
    for (const id of [
      "attach-service-worker",
      "tab-attach",
      "auto-attach",
      "auto-attach-iframe",
      "run-if-waiting-for-debugger",
      "worker-runtime-evaluate",
      "storage-get-cookies",
    ]) {
      expect(results[id], id).toMatchObject({ status: "unavailable" });
    }
  });

  test("records a failed release of a waiting target", async () => {
    const { api } = fakeDebugger({ "Runtime.runIfWaitingForDebugger": "Not attached" });
    const results = byId(await runAllProbes(api, URLS, noWait));
    expect(results["run-if-waiting-for-debugger"]).toMatchObject({
      status: "rejected",
      error: "Not attached",
    });
  });
});

describe("the harness global", () => {
  test("exposes the ids, runs the table, holds a tab, and reads its height", async () => {
    const { api } = fakeDebugger();
    const heights = new Map([[7, 1333]]);
    const tabHeight = async (tabId: number) => heights.get(tabId);
    exposeProbes(() => api, tabHeight);
    const harness = (globalThis as Record<string, unknown>)[HARNESS_GLOBAL] as ProbeHarness;
    expect(harness.ids).toEqual(PROBES.map((probe) => probe.id));
    expect(Object.keys(harness.descriptions)).toEqual(harness.ids);
    expect(await harness.tabHeight(URLS.pageUrl)).toBe(1333);
    expect(await harness.holdTab(URLS.pageUrl)).toBe(7);
    await harness.releaseTab(7);
    const nowhere = createProbeHarness(() => api, tabHeight);
    await expect(nowhere.holdTab("http://nowhere.test/")).rejects.toThrow(
      "no tab shows http://nowhere.test/",
    );
    await expect(nowhere.tabHeight("http://nowhere.test/")).rejects.toThrow(
      "no tab shows http://nowhere.test/",
    );
    heights.clear();
    await expect(harness.tabHeight(URLS.pageUrl)).rejects.toThrow("tab 7 has no height");
  });
});
