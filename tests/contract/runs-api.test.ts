import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { RunningService } from "../../apps/service/src/index.ts";
import type { Event } from "../../packages/protocol/src/index.ts";
import { command, send, startFresh, tempHome } from "./helpers.ts";
import { ASSET, SAVE, runEvents, seedRuns } from "./run-seeds.ts";

let home = "";
let service: RunningService;
beforeAll(async () => {
  home = await tempHome();
  await seedRuns(home, {
    baseline: {},
    same: {},
    growing: {},
    "server-error": { saveStatus: 500, statusFails: true },
    "lost-events": { gap: true },
    "wrong-text": { statusFails: true },
  });
  service = await startFresh(home);
});
afterAll(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

interface Answer {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string };
}

async function call(name: string, params: Record<string, unknown>): Promise<Answer> {
  const response = await command(service, { requestId: "r-1", command: name, params });
  return response.json as Answer;
}

const page = async (params: Record<string, unknown>) => {
  const { result, error } = await call("run.queryEvents", { runId: "baseline", ...params });
  if (result === undefined) throw new Error(`run.queryEvents failed: ${error?.code}`);
  return result as { events: Event[]; nextCursor?: string };
};
const ids = (events: Event[]) => events.map(({ id }) => id);
const urlOf = ({ payload }: Event) => (payload as Record<string, unknown>)["url"];

describe("run.queryEvents", () => {
  const journal = runEvents("baseline", {});

  test("filters by a list of event types", async () => {
    const { events } = await page({ types: ["step.started"] });
    expect(events.map(({ stepId }) => stepId)).toEqual(["open", "submit", "status"]);
  });

  test("filters by the origin of the event's URL and by the profile binding", async () => {
    expect(ids((await page({ origin: "http://127.0.0.1:4601" })).events)).toEqual(
      ids(journal.filter((event) => urlOf(event) === ASSET)),
    );
    const profile = (await page({ profile: "work" })).events;
    expect(profile.map(urlOf)).toEqual([SAVE, ASSET]);
    expect((await page({ profile: "personal" })).events).toEqual([]);
  });

  test("filters by a time range, from inclusive to exclusive", async () => {
    const { events } = await page({
      from: journal[2]?.timestamp,
      to: journal[5]?.timestamp,
      category: "network",
    });
    expect(ids(events)).toEqual(ids(journal.slice(3, 5)));
  });

  test("pages with a cursor that stays valid while the journal grows", async () => {
    const steps = { runId: "growing", types: ["step.started", "step.finished"], limit: 2 };
    const first = await page(steps);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page({ ...steps, cursor: first.nextCursor });
    const folder = join(home, ".recnrun", "flows", "save-form", "runs", "growing");
    const late = { ...journal.at(-1), runId: "growing", id: "engine:replay#99", seq: 99 };
    await appendFile(join(folder, "events.jsonl"), `${JSON.stringify(late)}\n`);
    expect(await page({ ...steps, cursor: first.nextCursor })).toEqual(second);
    const rest = await page({ ...steps, cursor: second.nextCursor, limit: 100 });
    const all = [...first.events, ...second.events, ...rest.events];
    expect(ids(all)).toEqual([
      ...ids(journal.filter(({ category }) => category === "step")),
      "engine:replay#99",
    ]);
    expect(rest.nextCursor).toBeUndefined();
  });

  test("refuses a cursor it did not return and a run it does not know", async () => {
    expect((await call("run.queryEvents", { runId: "baseline", cursor: "x" })).error?.code).toBe(
      "invalid-request",
    );
    expect((await call("run.queryEvents", { runId: "missing" })).error?.code).toBe("not-found");
  });
});

const compare = async (runId: string) => {
  const { result, error } = await call("run.compare", { baselineRunId: "baseline", runId });
  if (result === undefined) throw new Error(`run.compare failed: ${error?.code}`);
  return result;
};

describe("run.compare", () => {
  test("aligns two runs of the same revision and finds no divergence", async () => {
    expect(await compare("same")).toEqual({
      schemaVersion: 1,
      baselineRunId: "baseline",
      runId: "same",
      flowId: "save-form",
      sameRevision: true,
      steps: ["open", "submit", "status"].map((stepId, index) => ({
        stepId,
        index,
        baseline: "passed",
        run: "passed",
      })),
      divergence: null,
    });
  });

  test("names a different response status before the failure it caused", async () => {
    expect((await compare("server-error")).divergence).toMatchObject({
      kind: "application",
      reason: "network-status",
      stepId: "submit",
      index: 1,
      baseline: { url: SAVE, httpStatus: 200 },
      run: { url: SAVE, httpStatus: 500, eventId: "cdp:network#1" },
    });
  });

  test("reports lost events as a collector gap, never as the application", async () => {
    expect((await compare("lost-events")).divergence).toMatchObject({
      kind: "collector-gap",
      reason: "collector-gap",
      stepId: "submit",
      run: { gap: { reason: "buffer-exhausted", surface: "network", lost: 2 } },
    });
  });

  test("names a failed assertion", async () => {
    expect((await compare("wrong-text")).divergence).toMatchObject({
      kind: "application",
      reason: "assertion-failed",
      stepId: "status",
      index: 2,
      baseline: { status: "passed" },
      run: { status: "failed", error: { code: "assertion-failed" } },
    });
  });

  test("refuses an unknown run and malformed, anonymous, or foreign requests", async () => {
    expect((await call("run.compare", { baselineRunId: "baseline", runId: "x" })).error).toEqual(
      expect.objectContaining({ code: "not-found" }),
    );
    const body = { requestId: "r-2", command: "run.compare", params: { runId: "same" } };
    expect((await command(service, body)).status).toBe(400);
    const valid = { ...body, params: { baselineRunId: "baseline", runId: "same" } };
    expect((await send(service.port, { body: JSON.stringify(valid) })).status).toBe(401);
    expect((await command(service, valid, { origin: "https://evil.example" })).status).toBe(403);
  });
});
