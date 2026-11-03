import type { Lease, SessionStatus } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { harness, type Harness } from "./fakes.ts";

const resultOf = <T>(envelope: unknown): T => {
  expect(envelope).toMatchObject({ ok: true });
  return (envelope as { result: T }).result;
};
const codeOf = (envelope: unknown) => (envelope as { error?: { code: string } }).error?.code;
const fenceOf = ({ leaseId, fencingToken }: Lease) => ({ leaseId, fencingToken });

async function started(h: Harness): Promise<{ sessionId: string; lease: Lease }> {
  const { sessionId, lease } = resultOf<SessionStatus>(await h.call("session.start", {}));
  if (!lease) throw new Error("The person holds no lease.");
  return { sessionId, lease };
}

const ASSERTION = {
  id: "sent",
  assertion: "visible",
  target: {
    resolution: "orderedFallback",
    cardinality: "one",
    locators: [{ strategy: "testId", value: "send" }],
  },
};

test("a former holder's fence moves nothing once control passed on", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  const stale = { lease: fenceOf(lease) };
  const toAgent = await h.call("session.handoff", { sessionId, to: "agent" }, stale);
  const agent = resultOf<SessionStatus>(toAgent).lease;
  if (!agent) throw new Error("The agent holds no lease.");
  const mode = "pauseStepCreation";
  const refused = [
    await h.call("session.pause", { sessionId, mode }, stale),
    await h.call("session.pause", { sessionId, mode }),
    await h.call("session.stop", { sessionId }, stale),
    await h.call("picker.stop", { sessionId }, stale),
    await h.call("flow.addAssertion", { sessionId, step: ASSERTION }, stale),
  ];
  expect(refused.map(codeOf)).toEqual(Array(5).fill("stale-lease"));
  expect(resultOf<SessionStatus>(await h.call("session.status", { sessionId }))).toMatchObject({
    state: "recording",
    control: "agent",
  });
  const paused = await h.call("session.pause", { sessionId, mode }, { lease: fenceOf(agent) });
  expect(resultOf<SessionStatus>(paused).state).toBe("paused");
});

test("an expired fence is refused even when no lease remains, until the person takes control", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  h.advance(6e4 + 1);
  const expired = { lease: fenceOf(lease) };
  expect(codeOf(await h.call("picker.start", { sessionId }, expired))).toBe("stale-lease");
  expect(codeOf(await h.call("session.stop", { sessionId }, expired))).toBe("stale-lease");
  expect(h.browser.calls).not.toContain("pick");
  const back = resultOf<SessionStatus>(
    await h.call("session.handoff", { sessionId, to: "manual" }),
  );
  if (!back.lease) throw new Error("The person holds no lease.");
  const current = { lease: fenceOf(back.lease) };
  expect(resultOf(await h.call("picker.start", { sessionId }, current))).toMatchObject({
    picking: true,
  });
  const stopped = await h.call("session.stop", { sessionId }, current);
  expect(resultOf<SessionStatus>(stopped).state).toBe("finalizing");
});

/** Holds every picker startup until the returned release is called. */
function slowPicker(h: Harness): () => void {
  const pick = h.browser.pick.bind(h.browser);
  let release = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  h.browser.pick = async (...args) => (await opened, pick(...args));
  return release;
}

const countOf = (h: Harness, call: string) => h.browser.calls.filter((c) => c === call).length;

test("concurrent picker starts open one picker, and a stop during startup closes it", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  const current = { lease: fenceOf(lease) };
  const release = slowPicker(h);
  const starts = [
    h.call("picker.start", { sessionId }, current),
    h.call("picker.start", { sessionId }, current),
  ];
  const stopped = h.call("picker.stop", { sessionId }, current);
  release();
  await Promise.all([...starts, stopped]);
  expect(countOf(h, "pick")).toBe(1);
  expect(countOf(h, "pick.stop")).toBe(1);
  expect(h.deps.sessions.get(sessionId)?.picker).toBeUndefined();
});

test("a picker whose session stopped during startup is closed and refused", async () => {
  const h = await harness();
  const { sessionId, lease } = await started(h);
  const current = { lease: fenceOf(lease) };
  const release = slowPicker(h);
  const start = h.call("picker.start", { sessionId }, current);
  const stopped = h.call("session.stop", { sessionId }, current);
  release();
  expect(resultOf<SessionStatus>(await stopped).state).toBe("finalizing");
  expect(codeOf(await start)).toBe("conflict");
  expect(countOf(h, "pick.stop")).toBe(countOf(h, "pick"));
  expect(h.deps.sessions.get(sessionId)?.picker).toBeUndefined();
});
