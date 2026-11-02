import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createCdpAdapter } from "../../packages/adapter/src/index.ts";
import { runSteps, type ReplayOutcome } from "../../packages/engine/src/index.ts";
import { isStepResult, validateFlow, type Flow } from "../../packages/protocol/src/index.ts";
import { counters, expect, FIXTURE_ORIGIN, test, type FixtureApp } from "./fixtures/fixture-app.ts";

const NAME = "Ada Lovelace";
const STATUS = `Submitted ${NAME} (free, no contact, terms declined, no file)`;
const STEP_IDS = ["open", "fill-name", "submit", "read-status", "status"];

function loadFlow(): Flow {
  const file = new URL("./fixtures/replay-spike.flow.json", import.meta.url);
  const parsed = validateFlow(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.ok) throw new Error(`The spike flow is invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.flow;
}

/** The tab the adapter replayed in, as the test's own Playwright connection sees it. */
async function replayTab(app: FixtureApp): Promise<Page> {
  const find = () =>
    app.context.pages().find((page) => page.url().startsWith(`${FIXTURE_ORIGIN}/routes/form`));
  await expect.poll(() => find() !== undefined).toBe(true);
  const tab = find();
  if (!tab) throw new Error("The replay tab is gone.");
  return tab;
}

/** Replays the flow through the CDP adapter and reads the fixture's counters before leaving. */
async function replay(app: FixtureApp, wsEndpoint: string, fail: string) {
  const adapter = createCdpAdapter();
  await adapter.connect(wsEndpoint);
  try {
    const outcome: ReplayOutcome = await runSteps(adapter, loadFlow(), {
      env: { baseUrl: FIXTURE_ORIGIN, fail },
      inputs: { name: NAME },
    });
    const tab = await replayTab(app);
    const counted = await counters(tab);
    console.log(`Replay with fail=${JSON.stringify(fail)}: ${JSON.stringify(outcome)}`);
    console.log(`Fixture counters: ${JSON.stringify(counted)}`);
    return { outcome, tab, counted };
  } finally {
    await adapter.disconnect();
  }
}

test("replays the adapted §9 flow on the fixture with real input events", async ({
  app,
  chrome,
}) => {
  const { outcome, tab, counted } = await replay(app, chrome.wsEndpoint, "");
  expect(outcome.status).toBe("passed");
  expect(outcome.steps.map(({ stepId, status }) => [stepId, status])).toEqual(
    STEP_IDS.map((id) => [id, "passed"]),
  );
  expect(outcome.steps.every(isStepResult)).toBe(true);
  expect(outcome.steps[3]?.evidence).toEqual([`observed: ${JSON.stringify(STATUS)}`]);
  expect(outcome.vars).toEqual({ status: STATUS });
  // Trusted input, change, and click events prove input went through Chrome, not `.value =`.
  expect(counted).toMatchObject({ submits: 1, changes: 1, clicks: 1, untrusted: 0 });
  expect(counted.inputs).toBeGreaterThan(0);
  expect(await tab.getByTestId("name").inputValue()).toBe(NAME);
});

test("?fail=status fails exactly the assertion, with the observed text", async ({
  app,
  chrome,
}) => {
  const { outcome, counted } = await replay(app, chrome.wsEndpoint, "status");
  expect(outcome.status).toBe("failed");
  expect(outcome.steps.map(({ stepId, status }) => [stepId, status])).toEqual([
    ...STEP_IDS.slice(0, 4).map((id) => [id, "passed"]),
    ["status", "failed"],
  ]);
  expect(outcome.steps.every(isStepResult)).toBe(true);
  const observed = `Submitted nobody (free, no contact, terms declined, no file)`;
  expect(outcome.steps[4]).toMatchObject({
    error: { code: "assertion-failed" },
    evidence: [`expected: ${JSON.stringify(STATUS)}`, `observed: ${JSON.stringify(observed)}`],
  });
  expect(counted).toMatchObject({ submits: 1, clicks: 1, untrusted: 0 });
});
