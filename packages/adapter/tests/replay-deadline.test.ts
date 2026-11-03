import { replayFlow, systemClock } from "@recnrun/engine";
import type { Flow, Step } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { createPageDriver, type ReplayPage } from "../src/replay.ts";
import { fakePage } from "./replay-page.ts";

const HERE = "http://127.0.0.1:4600/";
const GO: Step = { id: "go", action: "navigate", url: HERE };
const never = () => new Promise<never>(() => undefined);

const flowOf = (steps: Step[]): Flow => ({
  schemaVersion: 1,
  id: "deadline",
  name: "Deadline",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps,
});

/** A driver over one fake tab whose methods named in `slow` take `ms`, or never answer. */
function driverWith(slow: Partial<Record<"title" | "bringToFront", number>>) {
  const { page } = fakePage({ url: HERE, title: "Fixture" });
  const later = (name: keyof typeof slow, answer: () => Promise<unknown>) => () => {
    const ms = slow[name];
    if (ms === undefined) return answer();
    if (ms === Infinity) return never();
    return new Promise((resolve) => setTimeout(resolve, ms)).then(answer);
  };
  const tab = {
    ...page,
    title: later("title", () => page.title()),
    bringToFront: later("bringToFront", () => page.bringToFront()),
  } as ReplayPage;
  return createPageDriver(async () => tab);
}

test("a URL assertion settles within its deadline though the title takes longer", async () => {
  const driver = driverWith({ title: 500 });
  const assertion: Step = { id: "at", assertion: "url", expected: HERE, timeoutMs: 50 };
  const started = Date.now();
  const outcome = await replayFlow(driver, flowOf([GO, assertion]), { clock: systemClock });
  expect(Date.now() - started).toBeLessThan(500);
  expect(outcome.steps[1]).toMatchObject({ status: "passed" });
});

test("listing tabs gives up on a title that never comes and keeps the URL", async () => {
  const driver = driverWith({ title: Infinity });
  await driver.act({ kind: "navigate", url: HERE }, { timeoutMs: 500 });
  expect(await driver.tabs({ timeoutMs: 10 })).toEqual({
    tabs: [{ url: HERE, title: "" }],
    current: 0,
  });
});

test("a tab switch that never answers ends unknown at its budget", async () => {
  const driver = driverWith({ bringToFront: Infinity });
  await driver.act({ kind: "navigate", url: HERE }, { timeoutMs: 500 });
  expect(await driver.act({ kind: "selectTab", index: 0 }, { timeoutMs: 10 })).toMatchObject({
    status: "unknown",
    code: "timeout",
  });
});
