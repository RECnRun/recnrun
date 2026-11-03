import {
  createSession,
  applySessionEvent,
  pauseSession,
  resumeSession,
  type Session,
  type SessionResult,
} from "../../packages/engine/src/index.ts";
import {
  ACTION_NAMES,
  ASSERTION_NAMES,
  isStepResult,
  type Event,
  type Step,
} from "../../packages/protocol/src/index.ts";
import { expect, FIXTURE_ORIGIN, test, type FixtureApp } from "./fixtures/fixture-app.ts";
import { flowOf, loadFlow, replayStored } from "./fixtures/replay.ts";

const REPLAY = `${FIXTURE_ORIGIN}/routes/replay`;
const OPEN: Step = { id: "open", action: "navigate", url: REPLAY };
const PIN = "pin-4321";

const statuses = (steps: readonly { stepId: string; status: string }[]) =>
  steps.map(({ stepId, status }) => [stepId, status]);

function ok(result: SessionResult): Session {
  if (!result.ok) throw new Error(`Session: ${JSON.stringify(result)}`);
  return result.session;
}

async function ordersOf(key: string): Promise<number> {
  const response = await fetch(`${FIXTURE_ORIGIN}/api/orders?key=${encodeURIComponent(key)}`);
  return ((await response.json()) as { count: number }).count;
}

function kindOf(step: Step): string {
  if ("action" in step) return step.action;
  return "assertion" in step ? step.assertion : "builtin";
}

/** The fixture's own view of a replay tab, through the test's Playwright connection. */
function tabAt(app: FixtureApp, prefix: string) {
  return app.context.pages().find((page) => page.url().startsWith(prefix));
}

test("replays every action, assertion, and extraction and stores each step", async ({ chrome }) => {
  const flow = loadFlow("replay.flow.json");
  const kinds = new Set(flow.steps.map(kindOf));
  expect([...ACTION_NAMES, ...ASSERTION_NAMES].filter((name) => !kinds.has(name))).toEqual([]);
  const { outcome, stored } = await replayStored(chrome.wsEndpoint, flow, {
    env: { base: FIXTURE_ORIGIN },
    inputs: { query: "apples" },
    secrets: { pin: PIN },
  });
  console.log(`Replay tour: ${JSON.stringify(outcome.summary)}`);
  expect(statuses(outcome.steps)).toEqual(flow.steps.map(({ id }) => [id, "passed"]));
  expect(outcome).toMatchObject({ status: "passed", exitCode: 0 });
  expect(outcome.vars).toEqual({ price: "Price: 12.50 EUR", sku: "P-42" });
  expect(stored.summary).toMatchObject({ status: "passed", exitCode: 0 });
  expect(stored.steps?.steps.map(({ stepId }) => stepId)).toEqual(flow.steps.map(({ id }) => id));
  expect(stored.steps?.steps.every(isStepResult)).toBe(true);
  // The secret was typed into the page, yet no stored file carries it.
  expect(JSON.stringify(stored)).not.toContain(PIN);
});

test("a failing assertion fails the run with the observed and expected text", async ({
  chrome,
}) => {
  const flow = flowOf("replay-fails", [
    OPEN,
    { id: "intro", assertion: "textEquals", target: { testId: "intro" }, expected: "Nothing" },
  ]);
  const { outcome, stored } = await replayStored(chrome.wsEndpoint, flow, {
    defaultTimeoutMs: 1_500,
  });
  expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
  expect(statuses(outcome.steps)).toEqual([
    ["open", "passed"],
    ["intro", "failed"],
  ]);
  const observed = "Every action, assertion, and extraction of a replayed flow.";
  expect(outcome.steps[1]).toMatchObject({
    error: { code: "assertion-failed" },
    evidence: [`expected: ${JSON.stringify("Nothing")}`, `observed: ${JSON.stringify(observed)}`],
  });
  expect(stored.summary).toMatchObject({ status: "failed", exitCode: 1 });
  expect(stored.steps?.steps).toHaveLength(2);
});

test("a click whose confirmation times out is never sent again", async ({ app, chrome }) => {
  const key = `order-${Date.now()}`;
  const flow = flowOf("replay-order", [
    { ...OPEN, url: `${REPLAY}?order=${key}&delay=3000` },
    { id: "place", action: "click", target: { testId: "place-order" }, timeoutMs: 1_000 },
    { id: "placed", assertion: "textEquals", target: { testId: "order-status" }, expected: "x" },
  ]);
  const { outcome } = await replayStored(chrome.wsEndpoint, flow, {}, async () => {
    // Wait for the late confirmation, so a second order would have been counted by now.
    await expect
      .poll(() => tabAt(app, `${REPLAY}?order=${key}&placed=${key}`) !== undefined)
      .toBe(true);
  });
  console.log(`Order replay: ${JSON.stringify(outcome.steps)}`);
  expect(await ordersOf(key)).toBe(1);
  expect(["indeterminate", "failed"]).toContain(outcome.steps[1]?.status);
  expect(outcome.steps.map(({ stepId }) => stepId)).toEqual(["open", "place"]);
  expect(outcome.status).not.toBe("passed");
});

test("a late element is found by polling and clicked once", async ({ app, chrome }) => {
  const flow = flowOf("replay-late", [
    OPEN,
    { id: "late", action: "click", target: { testId: "late" } },
    {
      id: "once",
      assertion: "textEquals",
      target: { testId: "late-status" },
      expected: "Late clicked 1",
    },
  ]);
  const { outcome } = await replayStored(chrome.wsEndpoint, flow, {}, async () => {
    const tab = tabAt(app, REPLAY);
    expect(await tab?.evaluate(() => window.__fixture?.counters.lateClicks)).toBe(1);
  });
  expect(outcome.status).toBe("passed");
  expect(outcome.steps[1]?.attempts).toBeGreaterThan(1);
});

test("a replayed click journals only the pointer sequence the page received", async ({
  app,
  chrome,
}) => {
  const flow = flowOf("replay-click-evidence", [
    OPEN,
    { id: "late", action: "click", target: { testId: "late" } },
  ]);
  const { outcome, stored } = await replayStored(chrome.wsEndpoint, flow, {}, async () => {
    const tab = tabAt(app, REPLAY);
    expect(await tab?.evaluate(() => window.__fixture?.counters.lateClicks)).toBe(1);
  });
  expect(outcome.status).toBe("passed");
  const dom = stored.journal.events
    .filter((event) => event.category === "dom" && event.stepId === "late")
    .map(({ type }) => type)
    .filter((type) => ["pointerdown", "focusin", "pointerup", "click"].includes(type));
  expect(dom).toEqual(["pointerdown", "focusin", "pointerup", "click"]);
});

test("pauseReplay holds the next step until the session resumes", async ({ chrome }) => {
  const flow = flowOf("replay-pause", [
    OPEN,
    { id: "intro", assertion: "visible", target: { testId: "intro" } },
  ]);
  let session = ok(applySessionEvent(createSession(), "start"));
  const seen: string[] = [];
  let resume: () => void = () => undefined;
  let paused: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (paused = resolve));
  // `observe` sees every journal line, snapshots included; the order of steps is what is held.
  const observe = (event: Event) => {
    if (event.category === "step") seen.push(`${event.type} ${event.stepId}`);
    if (event.type === "step.finished" && event.stepId === "open") {
      session = ok(pauseSession(session, "pauseReplay", Date.now()));
    }
  };
  const control = {
    session: () => session,
    changed: () => {
      paused();
      return new Promise<void>((resolve) => (resume = resolve));
    },
  };
  const running = replayStored(chrome.wsEndpoint, flow, { observe, control });
  expect(await Promise.race([held.then(() => "held"), running.then(() => "finished")])).toBe(
    "held",
  );
  expect(seen).toEqual(["step.started open", "step.finished open"]);
  session = ok(resumeSession(session, "pauseReplay", Date.now()));
  resume();
  const { outcome } = await running;
  expect(outcome.status).toBe("passed");
  expect(seen.slice(2)).toEqual(["step.started intro", "step.finished intro"]);
});

test("a step past its timeout fails with the timeout code", async ({ chrome }) => {
  const flow = flowOf("replay-timeout", [
    OPEN,
    { id: "never", action: "waitFor", target: { testId: "never" }, timeoutMs: 500 },
  ]);
  const started = Date.now();
  const { outcome } = await replayStored(chrome.wsEndpoint, flow);
  expect(outcome.steps[1]).toMatchObject({ status: "failed", error: { code: "timeout" } });
  expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
  expect(Date.now() - started).toBeLessThan(10_000);
});
