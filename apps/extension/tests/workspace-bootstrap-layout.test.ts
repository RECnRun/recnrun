import type { SessionLayout } from "@recnrun/domain";
import { expect, test } from "vite-plus/test";
import { BOOTSTRAP_STEPS, bootstrapIdentity } from "@/background/workspace/bootstrap";
import { COUNTS, DATA, ORIGIN, START, WINDOW, bootstrapHarness } from "./bootstrap-harness";
import { echoProbes, fakePort } from "./fake-port";

const LAYOUT: SessionLayout = {
  windows: [
    {
      focused: false,
      tabs: [
        { url: START, active: true, sessionStorage: [] },
        { url: `${ORIGIN}/app/?tab=2`, active: false, sessionStorage: [] },
      ],
    },
    { focused: true, tabs: [{ url: `${ORIGIN}/app/?tab=3`, active: true, sessionStorage: [] }] },
  ],
  primary: { window: 0, tab: 0 },
};

test("reopens the identity's other tabs and windows last, once the app is released", async () => {
  const { deps, navigation } = bootstrapHarness();
  const timings = await bootstrapIdentity(START, { ...DATA, layout: LAYOUT }, deps, "op-1");
  expect(timings.map(({ step }) => step)).toEqual(BOOTSTRAP_STEPS);
  expect(navigation.reloads).toHaveLength(1);
  expect(deps.layout.calls).toEqual([
    "tab 200 in 5 at 1",
    "activate 9",
    `navigate 200 ${ORIGIN}/app/?tab=2`,
    "window 50",
    `navigate 500 ${ORIGIN}/app/?tab=3`,
    "activate 500",
    "focus 50",
  ]);
  expect(deps.windows.close).not.toHaveBeenCalled();
});

test("a start whose layout fails closes every window it opened, its own and the reopened ones", async () => {
  const { deps, records } = bootstrapHarness();
  deps.layout.focus.mockRejectedValue(new Error("No window with id: 50."));
  const data = { ...DATA, layout: LAYOUT };
  await expect(bootstrapIdentity(START, data, deps, "op-1")).rejects.toThrow(
    "No window with id: 50.",
  );
  expect(deps.windows.close).toHaveBeenCalledWith([5, 50]);
  expect(records.at(-1)).toMatchObject({ status: "failed", step: "layout" });
});

test("a start without a layout opens no other tab or window", async () => {
  const { deps } = bootstrapHarness();
  await bootstrapIdentity(START, DATA, deps, "op-1");
  expect(deps.layout.calls).toEqual([]);
});

const OTHER = "http://other.localhost:5192";

test("writes the primary tab's sessionStorage of another origin in that tab, before its app loads", async () => {
  const { deps, navigation } = bootstrapHarness();
  const restores: unknown[] = [];
  const app = navigation.update;
  navigation.update = async (tabId, url) => {
    if (new URL(url).origin !== OTHER) return app(tabId, url);
    navigation.updates.push({ tabId, url });
    const sender = { tab: { id: tabId }, frameId: 0, documentId: "doc-other", origin: OTHER };
    const agent = echoProbes(fakePort(sender));
    const post = agent.postMessage;
    agent.postMessage = (message: unknown) => {
      post(message);
      const { type, operationId, generation, payload } = message as Record<string, unknown>;
      if (type !== "restore") return;
      restores.push(payload);
      const tag = { operationId, generation };
      queueMicrotask(() => agent.onMessage.emit({ type: "restored", counts: COUNTS, ...tag }));
    };
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId: "doc-other" });
    navigation.onConnect.emit(agent);
  };
  const primary = LAYOUT.windows[0]?.tabs[0];
  if (primary === undefined) throw new Error("The layout lost its primary tab.");
  const sessionStorage = [{ origin: OTHER, entries: { step: "2" } }];
  const windows = [
    { ...LAYOUT.windows[0], focused: false, tabs: [{ ...primary, sessionStorage }] },
  ];
  const layout = { ...LAYOUT, windows };
  await bootstrapIdentity(START, { ...DATA, layout }, deps, "op-1");
  expect(navigation.updates.map(({ tabId, url }) => `${tabId} ${url}`).slice(0, 2)).toEqual([
    `${WINDOW.tabId} ${OTHER}/`,
    `${WINDOW.tabId} ${START}`,
  ]);
  expect(restores).toEqual([
    { localStorage: {}, sessionStorage: { step: "2" }, indexedDB: [], caches: [] },
  ]);
  expect(await deps.visits.tabVisits(WINDOW.generation)).toEqual([
    { tabId: WINDOW.tabId, from: { window: 0, tab: 0 }, visits: [{ origin: OTHER }] },
  ]);
});
