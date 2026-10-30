import type { OriginCapture } from "@recnrun/domain";
import { expect, test } from "vite-plus/test";
import { BOOTSTRAP_STEPS, bootstrapIdentity } from "@/background/workspace/bootstrap";
import { COUNTS, DATA, ORIGIN, START, bootstrapHarness } from "./bootstrap-harness";
import { helperNavigation } from "./fake-helper";

const SSO = "http://sso.localhost:5192";
const SSO_SITE = { localStorage: { idp_user: "A" }, sessionStorage: {}, indexedDB: [], caches: [] };
const SSO_DATA: OriginCapture = { origin: SSO, ...SSO_SITE };

/** A bootstrap whose helper tab's agents answer each restore with `reply`. */
function restoring(reply: object) {
  const harness = bootstrapHarness();
  const { deps, barrier } = harness;
  const restores: { payload: unknown; rules: number }[] = [];
  helperNavigation(deps.navigation, deps.helperTabs, (command) => {
    if (command.type !== "restore") return [];
    const { payload } = command as { payload?: unknown };
    restores.push({ payload, rules: barrier.rules.size });
    return [reply];
  });
  const data = { ...DATA, origins: [SSO_DATA] };
  return { ...harness, restores, running: bootstrapIdentity(START, data, deps, "op-1") };
}

test("restores each other visited origin in a helper tab before the target, and notes them all", async () => {
  const run = restoring({ type: "restored", counts: COUNTS });
  const timings = await run.running;
  expect(timings.map(({ step }) => step)).toEqual(BOOTSTRAP_STEPS);
  // The origin is the place, not part of what its page restores.
  expect(run.restores).toEqual([{ payload: SSO_SITE, rules: 6 }]);
  expect(run.deps.helperTabs.opened).toEqual([{ tabId: 100, windowId: 5 }]);
  expect(run.deps.helperTabs.closed).toEqual([100]);
  expect(run.navigation.updates).toEqual([
    { tabId: 100, url: `${SSO}/` },
    { tabId: 9, url: START },
  ]);
  expect(run.seen.restorePayload).toEqual(DATA.site);
  // The next capture of this window keeps every origin, even one the app never loads again.
  expect(run.deps.visits.list).toEqual({
    generation: 2,
    visits: [{ origin: ORIGIN }, { origin: SSO }],
  });
  expect(run.records.at(-1)).not.toHaveProperty("skipped");
  expect(run.barrier.rules.size).toBe(0);
});

test("a visited origin that cannot be restored is skipped, and the app still opens", async () => {
  const run = restoring({ type: "failed", error: "QuotaExceededError" });
  const timings = await run.running;
  expect(timings.map(({ step }) => step)).toEqual(BOOTSTRAP_STEPS);
  const skipped = [
    {
      origin: SSO,
      work: "restore",
      step: "restore",
      reason: "The page could not restore its data (QuotaExceededError).",
      kept: true,
    },
  ];
  // The journal names the origin and its step from then on, through the start's end.
  expect(run.records.find(({ step }) => step === "barrier")).toMatchObject({ skipped });
  expect(run.records.at(-1)).toMatchObject({ status: "done", skipped });
  expect(run.deps.windows.close).not.toHaveBeenCalled();
  expect(run.navigation.updates.map(({ tabId }) => tabId)).toEqual([100, 9]);
  expect(run.deps.helperTabs.closed).toEqual([100]);
  // The window never held the origin's saved storage, so the next capture keeps it as saved.
  expect(run.deps.visits.list.visits).toEqual([{ origin: ORIGIN }, { origin: SSO, carry: true }]);
  expect(run.barrier.rules.size).toBe(0);
  expect(run.barrier.scripts.size).toBe(0);
});

test("a visited origin that does not answer is skipped at the navigate step", async () => {
  const run = bootstrapHarness();
  const { deps } = run;
  const managed = deps.navigation.update;
  deps.navigation.update = async (tabId, url) => {
    if (tabId !== 100) return managed(tabId, url);
    deps.navigation.onErrorOccurred.emit({ tabId, frameId: 0, error: "net::ERR_EMPTY_RESPONSE" });
  };
  await bootstrapIdentity(START, { ...DATA, origins: [SSO_DATA] }, deps, "op-1");
  expect(run.records.at(-1)).toMatchObject({
    status: "done",
    skipped: [{ origin: SSO, step: "navigate", kept: true }],
  });
});
