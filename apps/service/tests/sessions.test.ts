import { join } from "node:path";
import type { BodySink } from "@recnrun/adapter";
import { openBlobStore, readJournal } from "@recnrun/persistence";
import type { CapturedEvent, Lease, ServiceMessage, SessionStatus } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { fillAndClick, harness, navigated, SEND_BUTTON, type Harness } from "./fakes.ts";

const resultOf = <T>(envelope: unknown): T => {
  expect(envelope).toMatchObject({ ok: true });
  return (envelope as { result: T }).result;
};
const codeOf = (envelope: unknown) => (envelope as { error?: { code: string } }).error?.code;
const fenceOf = ({ leaseId, fencingToken }: Lease) => ({ leaseId, fencingToken });

async function started(h: Harness): Promise<SessionStatus> {
  return resultOf<SessionStatus>(await h.call("session.start", {}));
}

/** The fence of a status, as a command carries it. */
const fenced = ({ lease }: SessionStatus) => (lease ? { lease: fenceOf(lease) } : {});

const journalOf = (h: Harness, sessionId: string) =>
  readJournal(join(h.home, ".recnrun", "sessions", sessionId, "events.jsonl"));

test("session.start records a page of its own and gives the person control", async () => {
  const h = await harness();
  const status = await started(h);
  expect(status).toMatchObject({ state: "recording", control: "manual" });
  expect(status.lease).toMatchObject({ holderId: "person", kind: "manual", targetId: "page-1" });
  expect(h.browser.calls).toEqual(["discover ", "record"]);
  expect(h.published.at(-1)).toEqual({
    type: "session.status",
    sessionId: status.sessionId,
    status,
  });
  expect(resultOf(await h.call("session.status", { sessionId: status.sessionId }))).toEqual(status);
});

test("captured events are journaled, pushed, and suggested as steps", async () => {
  const h = await harness();
  const status = await started(h);
  const { sessionId } = status;
  for (const event of fillAndClick(1)) h.browser.emit(event);
  const suggested = resultOf<{ steps: { action: string }[] }>(
    await h.call("session.suggestions", { sessionId }),
  );
  expect(suggested.steps.map(({ action }) => action)).toEqual(["fill", "click"]);
  expect(h.published.filter(({ type }) => type === "session.event")).toHaveLength(7);
  resultOf(await h.call("session.stop", { sessionId }, fenced(status)));
  expect((await journalOf(h, sessionId)).events).toHaveLength(7);
});

test("the three pauses: no steps, then no capture and a gap in the journal", async () => {
  const h = await harness();
  const status = await started(h);
  const { sessionId } = status;
  const pause = (mode: string) => h.call("session.pause", { sessionId, mode }, fenced(status));
  const resume = (mode: string) => h.call("session.resume", { sessionId, mode }, fenced(status));
  expect(resultOf<SessionStatus>(await pause("pauseStepCreation")).state).toBe("paused");
  for (const event of fillAndClick(1)) h.browser.emit(event);
  h.browser.emit(navigated(8, "http://127.0.0.1:4600/routes/links"));
  expect(resultOf<SessionStatus>(await resume("pauseStepCreation")).state).toBe("recording");
  expect(codeOf(await resume("pauseStepCreation"))).toBe("conflict");
  await pause("suspendCapture");
  for (const event of fillAndClick(20)) h.browser.emit(event);
  await resume("suspendCapture");
  expect(
    resultOf<{ steps: unknown[] }>(await h.call("session.suggestions", { sessionId })).steps,
  ).toEqual([]);
  resultOf(await h.call("session.stop", { sessionId }, fenced(status)));
  const { events } = await journalOf(h, sessionId);
  expect(events.map(({ category }) => category)).toEqual([
    ...Array(7).fill("dom"),
    "navigation",
    "gap",
  ]);
  expect(events.at(-1)?.payload).toMatchObject({ reason: "capture-suspended" });
});

/** Capture that still delivers on stop: `drain` runs while it settles, `last` when it stops. */
function drainingCapture(h: Harness, drain: () => Promise<void>, last: CapturedEvent[]): void {
  const record = h.browser.record.bind(h.browser);
  h.browser.record = async (endpoint, capture) => {
    const handle = await record(endpoint, capture);
    const stop = () => {
      for (const event of last) capture.onEvent(event);
      handle.stop();
    };
    return { targetId: handle.targetId, settled: drain, stop };
  };
}

const categoriesOf = async (h: Harness, sessionId: string) =>
  (await journalOf(h, sessionId)).events.map(({ category, payload }) =>
    category === "gap" ? `gap:${String((payload as { reason: string }).reason)}` : category,
  );

test("stop keeps what capture delivers while it drains, and a failed drain is a gap", async () => {
  const h = await harness();
  const links = navigated(8, "http://127.0.0.1:4600/routes/links");
  drainingCapture(h, async () => fillAndClick(1).forEach((event) => h.browser.emit(event)), [
    links,
  ]);
  const status = await started(h);
  resultOf(await h.call("session.stop", { sessionId: status.sessionId }, fenced(status)));
  expect(await categoriesOf(h, status.sessionId)).toEqual([...Array(7).fill("dom"), "navigation"]);
  const suggested = await h.call("session.suggestions", { sessionId: status.sessionId });
  expect(resultOf<{ steps: { action: string }[] }>(suggested).steps.map((s) => s.action)).toEqual([
    "fill",
    "click",
  ]);
  const lost = await harness();
  drainingCapture(lost, () => Promise.reject(new Error("The socket closed.")), [links]);
  const failed = await started(lost);
  resultOf(await lost.call("session.stop", { sessionId: failed.sessionId }, fenced(failed)));
  expect(await categoriesOf(lost, failed.sessionId)).toEqual(["gap:capture-stopped", "navigation"]);
});

test("a session hands capture a blob store beside its journal for response bodies", async () => {
  const h = await harness();
  let blobs: BodySink | undefined;
  const record = h.browser.record.bind(h.browser);
  h.browser.record = async (endpoint, capture) => (
    (blobs = capture.blobs),
    record(endpoint, capture)
  );
  const { sessionId } = await started(h);
  if (!blobs) throw new Error("The session recorded without a blob store.");
  const meta = { mime: "application/json", encoding: "utf8" } as const;
  const ref = await blobs.put(new TextEncoder().encode('{"ok":true}'), meta);
  expect(ref).toMatchObject({ ...meta, size: 11, condition: "captured" });
  const folder = join(h.home, ".recnrun", "sessions", sessionId, "blobs");
  const stored = await (await openBlobStore({ folder })).read(ref.sha256);
  expect(stored.toString("utf8")).toBe('{"ok":true}');
});

test("a session stopped while capture is suspended journals that gap", async () => {
  const h = await harness();
  const status = await started(h);
  const { sessionId } = status;
  const mode = "suspendCapture";
  resultOf(await h.call("session.pause", { sessionId, mode }, fenced(status)));
  for (const event of fillAndClick(1)) h.browser.emit(event);
  resultOf(await h.call("session.stop", { sessionId }, fenced(status)));
  expect(await categoriesOf(h, sessionId)).toEqual(["gap:capture-suspended"]);
});

test("handing control away needs the holder's fence; a person takes it back at once", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  if (!lease) throw new Error("The person holds no lease.");
  expect(codeOf(await h.call("session.handoff", { sessionId, to: "agent" }))).toBe("stale-lease");
  const toAgent = await h.call(
    "session.handoff",
    { sessionId, to: "agent" },
    { lease: fenceOf(lease) },
  );
  expect(resultOf<SessionStatus>(toAgent)).toMatchObject({ control: "agent" });
  const back = resultOf<SessionStatus>(
    await h.call("session.handoff", { sessionId, to: "manual" }),
  );
  expect(back).toMatchObject({ control: "manual", lease: { holderId: "person" } });
  const away = await h.call(
    "session.handoff",
    { sessionId, to: "unassigned" },
    { lease: fenceOf(lease) },
  );
  expect(codeOf(away)).toBe("stale-lease");
});

test("the picker pushes each pick with its locators and needs the current fence", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  if (!lease) throw new Error("The person holds no lease.");
  expect(codeOf(await h.call("picker.start", { sessionId }))).toBe("stale-lease");
  const picking = await h.call("picker.start", { sessionId }, { lease: fenceOf(lease) });
  expect(resultOf(picking)).toEqual({ sessionId, picking: true });
  h.browser.pickElement(SEND_BUTTON);
  const picked = h.published.find((message) => message.type === "picker.picked");
  expect(picked).toMatchObject({ sessionId, target: SEND_BUTTON });
  expect(
    (picked as Extract<ServiceMessage, { type: "picker.picked" }>).locators.locators[0],
  ).toEqual({ strategy: "testId", value: "send" });
  expect(resultOf(await h.call("picker.stop", { sessionId }, { lease: fenceOf(lease) }))).toEqual({
    sessionId,
    picking: false,
  });
  expect(h.browser.calls).toContain("pick.stop");
});

test("finalize stores the suggested steps, then the draft assertions, once the session stopped", async () => {
  const h = await harness();
  const status = await started(h);
  const { sessionId } = status;
  const fence = fenced(status);
  for (const event of fillAndClick(1)) h.browser.emit(event);
  expect(codeOf(await h.call("flow.finalize", { sessionId }, fence))).toBe("conflict");
  const picked = {
    resolution: "orderedFallback",
    cardinality: "one",
    locators: [{ strategy: "testId", value: "send" }],
  };
  const step = { id: "sent", assertion: "visible", target: picked };
  expect(resultOf(await h.call("flow.addAssertion", { sessionId, step }, fence))).toEqual({
    stepId: "sent",
  });
  expect(codeOf(await h.call("flow.addAssertion", { sessionId, step }, fence))).toBe("conflict");
  expect(resultOf<SessionStatus>(await h.call("session.stop", { sessionId }, fence)).state).toBe(
    "finalizing",
  );
  expect(h.browser.calls).toContain("record.stop");
  const saved = resultOf<{ flowId: string; revision: string }>(
    await h.call("flow.finalize", { sessionId }),
  );
  const stored = await h.flows.get(saved.flowId);
  expect(stored.revision).toBe(saved.revision);
  expect(stored.manifest.status).toBe("recorded");
  expect(stored.flow.steps.map(({ id }) => id)).toEqual(["fill-1", "click-2", "sent"]);
  expect(stored.flow.steps.at(-1)).toEqual({
    id: "sent",
    assertion: "visible",
    target: { testId: "send" },
  });
  expect(resultOf<SessionStatus>(await h.call("session.status", { sessionId })).state).toBe(
    "completed",
  );
  expect(codeOf(await h.call("session.stop", { sessionId }))).toBe("conflict");
});

test("an unknown session is not found and no Chrome is a refusal with the remedy", async () => {
  const h = await harness();
  expect(codeOf(await h.call("session.status", { sessionId: "nope" }))).toBe("not-found");
  h.browser.found = { ok: false, code: "missing-file", remedy: "Open Chrome.", userDataDir: "/x" };
  expect(await h.call("session.start", {})).toMatchObject({
    ok: false,
    error: { code: "capability-unavailable", message: "Open Chrome." },
  });
});

test("actors bound to one profile record in that profile's Chrome", async () => {
  const h = await harness();
  const binding = (name: string) => ({
    name,
    userDataDir: `/profiles/${name}`,
    browserContextIds: [],
    chrome: "Chrome/156.0.8078.79",
    wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/fake",
    createdAt: "2026-11-03T10:00:00.000Z",
    lastSeenAt: "2026-11-03T10:00:00.000Z",
  });
  await h.deps.bindings.save(binding("ana"));
  await h.deps.bindings.save(binding("bea"));
  expect(
    resultOf<{ profiles: unknown[] }>(await h.call("profiles.list", {})).profiles,
  ).toHaveLength(2);
  resultOf(await h.call("session.start", { actors: { a: "ana", b: "ana" } }));
  expect(h.browser.calls[0]).toBe("discover /profiles/ana");
  const unknown = await h.call("session.start", { actors: { a: "zoe" } });
  expect(codeOf(unknown)).toBe("not-found");
  const two = await h.call("session.start", { actors: { a: "ana", b: "bea" } });
  expect(codeOf(two)).toBe("capability-unavailable");
});

test("events.subscribe needs the WebSocket and ends with it", async () => {
  const h = await harness();
  expect(codeOf(await h.call("events.subscribe", {}))).toBe("invalid-request");
  const pushed: ServiceMessage[] = [];
  let close = () => {};
  const channel = {
    push: (m: ServiceMessage) => pushed.push(m),
    onClose: (l: () => void) => (close = l),
  };
  const { sessionId } = await started(h);
  await h.call("events.subscribe", { sessionId }, { channel });
  const [first, second] = fillAndClick(1);
  if (!first || !second) throw new Error("No events to emit.");
  h.browser.emit(first);
  expect(pushed.map(({ type }) => type)).toEqual(["session.event"]);
  close();
  h.browser.emit(second);
  expect(pushed).toHaveLength(1);
});
