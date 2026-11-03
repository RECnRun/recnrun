import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplayDriver } from "@recnrun/engine";
import { ServiceMessageSchema, type Flow, type RunSummary } from "@recnrun/protocol";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { harness, type Harness } from "./fakes.ts";
import { cancelReplays } from "@/runs";

const resultOf = <T>(envelope: unknown): T => {
  expect(envelope).toMatchObject({ ok: true });
  return (envelope as { result: T }).result;
};
const codeOf = (envelope: unknown) => (envelope as { error?: { code: string } }).error?.code;

/** The summaries of the `run.finished` pushes; every push must be a valid service message. */
const finishedOf = (h: Harness) =>
  h.published.flatMap((message) => {
    expect(v.is(ServiceMessageSchema, message)).toBe(true);
    return message.type === "run.finished" ? [message.summary] : [];
  });

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

async function replaying(h: Harness, extra: Partial<ReplayDriver> = {}) {
  const gated = gatedDriver();
  let closed = false;
  h.browser.replayDriver = async () => ({
    driver: { ...gated.driver, ...extra },
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
  expect(finishedOf(h)).toEqual([
    expect.objectContaining({
      runId,
      flowId: flow.id,
      status: "error",
      exitCode: 2,
      counts: expect.objectContaining({ total: 2, pending: 2, passed: 0 }),
      failures: [{ stepId: "open", message: "No replay in this fake." }],
    }),
  ]);
});

test("a replay whose journal fails closes that journal and ends as an internal error", async () => {
  const h = await harness();
  const real = h.flows;
  let closes = 0;
  h.deps.store = () => ({
    ...real,
    createRun: async (manifest) => {
      const handle = await real.createRun(manifest);
      const journal = {
        path: handle.journal.path,
        append: () => Promise.reject(new Error("The disk is full.")),
        close: async () => {
          closes += 1;
          await handle.journal.close();
        },
      };
      return { ...handle, journal };
    },
  });
  const run = await replaying(h);
  run.release();
  await Promise.all(h.deps.active);
  expect(closes).toBe(1);
  expect(h.deps.journals.openCount).toBe(0);
  expect(codeOf(await h.call("run.summary", { runId: run.runId }))).toBe("internal");
  const [finished, ...more] = finishedOf(h);
  expect(more).toEqual([]);
  expect(finished).toMatchObject({ runId: run.runId, status: "error", exitCode: 2 });
});

test("a cancelled replay finishes its step under way, skips the rest, and is interrupted", async () => {
  const h = await harness();
  const run = await replaying(h);
  await expect.poll(() => run.commands).toEqual(["navigate"]);
  cancelReplays(h.deps);
  run.release();
  await Promise.all(h.deps.active);
  expect(run.commands).toEqual(["navigate"]);
  const summary = resultOf<RunSummary>(await h.call("run.summary", { runId: run.runId }));
  expect(summary.status).toBe("interrupted");
  expect(h.deps.journals.openCount).toBe(0);
  cancelReplays(h.deps);
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

test("run.getArtifact answers the blobs a run's events reference, and nothing else", async () => {
  const h = await harness();
  const run = await replaying(h, {
    capture: async () => ({
      tab: true,
      url: "http://127.0.0.1:4600/routes/form",
      html: { ok: true, value: "<html><body>Form</body></html>" },
      screenshot: { ok: true, value: new Uint8Array([137, 80, 78, 71]) },
    }),
  });
  run.release();
  await Promise.all(h.deps.active);
  type Part = { sha256: string };
  type Page = { events: { payload: { milestone: string; dom: Part; screenshot: Part } }[] };
  const query = { runId: run.runId, category: "snapshot" };
  const { events } = resultOf<Page>(await h.call("run.queryEvents", query));
  const milestones = events.map(({ payload }) => payload.milestone);
  expect(milestones).toEqual(["before", "after", "before", "after"]);
  const first = events[0]?.payload;
  if (!first) throw new Error("The run journaled no snapshot.");
  const { dom, screenshot } = first;
  const html = await h.call("run.getArtifact", { runId: run.runId, sha256: dom.sha256 });
  expect(resultOf(html)).toEqual({
    sha256: dom.sha256,
    mime: "text/html",
    encoding: "utf8",
    size: 30,
    data: "<html><body>Form</body></html>",
  });
  const png = await h.call("run.getArtifact", { runId: run.runId, sha256: screenshot.sha256 });
  expect(resultOf(png)).toMatchObject({ mime: "image/png", encoding: "binary", data: "iVBORw==" });
  const unreferenced = { runId: run.runId, sha256: "0".repeat(64) };
  expect(codeOf(await h.call("run.getArtifact", unreferenced))).toBe("not-found");
  const malformed = { runId: run.runId, sha256: "../summary.json" };
  expect(codeOf(await h.call("run.getArtifact", malformed))).toBe("invalid-request");
  const unknown = { runId: "nope", sha256: dom.sha256 };
  expect(codeOf(await h.call("run.getArtifact", unknown))).toBe("not-found");
  const files = await readdir(h.home, { recursive: true });
  const blob = join(h.home, files.find((file) => file.endsWith(`blobs/${dom.sha256}`)) ?? "");
  const request = { runId: run.runId, sha256: dom.sha256 };
  await writeFile(blob, "tampered");
  const corrupt = await h.call("run.getArtifact", request);
  expect(corrupt).toMatchObject({ error: { code: "internal" } });
  expect(JSON.stringify(corrupt)).not.toContain(h.home);
  await rm(blob);
  expect(codeOf(await h.call("run.getArtifact", request))).toBe("not-found");
});
