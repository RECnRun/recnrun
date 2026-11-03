import type { ReplayDriver } from "@recnrun/engine";
import type { Flow, RunSummary } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { harness, type Harness } from "./fakes.ts";

const resultOf = <T>(envelope: unknown): T => {
  expect(envelope).toMatchObject({ ok: true });
  return (envelope as { result: T }).result;
};
const codeOf = (envelope: unknown) => (envelope as { error?: { code: string } }).error?.code;

const flow: Flow = {
  schemaVersion: 1,
  id: "send-form",
  name: "Send the form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/form" },
    { id: "send", action: "click", target: { testId: "send" } },
  ],
};

/** A page where everything is found; the first write waits until the test releases it. */
function gatedDriver() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const commands: string[] = [];
  const driver: ReplayDriver = {
    inspect: async () => ({
      count: 1,
      visible: true,
      enabled: true,
      editable: true,
      text: "",
      value: null,
    }),
    readAttribute: async () => null,
    tabs: async () => ({ tabs: [{ url: "http://127.0.0.1:4600/", title: "" }], current: 0 }),
    act: async (command) => {
      commands.push(command.kind);
      await gate;
      return { status: "done" };
    },
  };
  return { driver, release, commands };
}

async function replaying(h: Harness) {
  const gated = gatedDriver();
  let closed = false;
  h.browser.replayDriver = async () => ({
    driver: gated.driver,
    close: async () => void (closed = true),
  });
  await h.flows.saveFlow(flow);
  const { runId } = resultOf<{ runId: string }>(await h.call("flow.replay", { flowId: flow.id }));
  return { runId, ...gated, closed: () => closed };
}

test("a replay answers at once, is a conflict while running, then has its summary", async () => {
  const h = await harness();
  const run = await replaying(h);
  expect(codeOf(await h.call("run.summary", { runId: run.runId }))).toBe("conflict");
  run.release();
  await Promise.all(h.deps.active);
  const summary = resultOf<RunSummary>(await h.call("run.summary", { runId: run.runId }));
  expect(summary).toMatchObject({ runId: run.runId, flowId: flow.id, status: "passed" });
  expect(run.commands).toEqual(["navigate", "click"]);
  expect(run.closed()).toBe(true);
  const types = h.published.map(({ type }) => type);
  expect(types.filter((type) => type === "run.step").length).toBeGreaterThan(0);
  expect(types.at(-1)).toBe("run.finished");
  h.deps.runs.clear();
  expect(resultOf<RunSummary>(await h.call("run.summary", { runId: run.runId }))).toEqual(summary);
});

test("run.queryEvents pages the journal and filters by category and step", async () => {
  const h = await harness();
  const run = await replaying(h);
  run.release();
  await Promise.all(h.deps.active);
  type Page = { events: { stepId?: string; category: string }[]; nextCursor?: string };
  const all = resultOf<Page>(await h.call("run.queryEvents", { runId: run.runId }));
  expect(all.nextCursor).toBeUndefined();
  const first = resultOf<Page>(await h.call("run.queryEvents", { runId: run.runId, limit: 1 }));
  expect(first).toEqual({ events: all.events.slice(0, 1), nextCursor: "1" });
  const rest = await h.call("run.queryEvents", { runId: run.runId, cursor: "1", limit: 1000 });
  expect(resultOf<Page>(rest).events).toEqual(all.events.slice(1));
  const send = resultOf<Page>(
    await h.call("run.queryEvents", { runId: run.runId, stepId: "send" }),
  );
  expect(send.events.length).toBeGreaterThan(0);
  expect(send.events.every(({ stepId }) => stepId === "send")).toBe(true);
  const gaps = await h.call("run.queryEvents", { runId: run.runId, category: "gap" });
  expect(resultOf<Page>(gaps).events).toEqual([]);
  const bad = await h.call("run.queryEvents", { runId: run.runId, cursor: "x" });
  expect(codeOf(bad)).toBe("invalid-request");
});

test("unknown flows, runs, and datasets are not found; no Chrome refuses the replay", async () => {
  const h = await harness();
  expect(codeOf(await h.call("flow.replay", { flowId: "nope" }))).toBe("not-found");
  expect(codeOf(await h.call("run.summary", { runId: "nope" }))).toBe("not-found");
  expect(codeOf(await h.call("run.queryEvents", { runId: "nope" }))).toBe("not-found");
  await h.flows.saveFlow(flow);
  const missing = await h.call("flow.replay", { flowId: flow.id, dataset: "nope" });
  expect(codeOf(missing)).toBe("not-found");
  h.browser.found = { ok: false, code: "missing-file", remedy: "Open Chrome.", userDataDir: "/x" };
  expect(codeOf(await h.call("flow.replay", { flowId: flow.id }))).toBe("capability-unavailable");
});

test("a replay that cannot reach Chrome ends as an internal error", async () => {
  const h = await harness();
  await h.flows.saveFlow(flow);
  const { runId } = resultOf<{ runId: string }>(await h.call("flow.replay", { flowId: flow.id }));
  await Promise.all(h.deps.active);
  expect(await h.call("run.summary", { runId })).toMatchObject({
    ok: false,
    error: { code: "internal", message: "No replay in this fake." },
  });
});

test("flows are validated, saved, imported, listed, and read back", async () => {
  const h = await harness();
  const invalid = resultOf<{ ok: boolean }>(await h.call("flow.validate", { flow: { id: 1 } }));
  expect(invalid.ok).toBe(false);
  const saved = resultOf<{ flowId: string; revision: string }>(await h.call("flow.save", { flow }));
  expect(saved.flowId).toBe(flow.id);
  const again = resultOf<{ revision: string }>(await h.call("flow.import", { flow }));
  expect(again.revision).toBe(saved.revision);
  const listed = resultOf<{ flows: { id: string }[] }>(await h.call("flow.list", {}));
  expect(listed.flows.map(({ id }) => id)).toEqual([flow.id]);
  const got = resultOf<{ flow: Flow; revision: string }>(
    await h.call("flow.get", { flowId: flow.id }),
  );
  expect(got).toMatchObject({ flow, revision: saved.revision });
  expect(codeOf(await h.call("flow.get", { flowId: "nope" }))).toBe("not-found");
  const twice = { ...flow, steps: [...flow.steps, ...flow.steps] };
  expect(codeOf(await h.call("flow.save", { flow: twice }))).toBe("invalid-request");
});
