import { expect, test } from "vite-plus/test";
import { resolveFunctionLocator } from "../src/index.ts";
import { blockedOnce, NEVER, object, page, request } from "./function-locator-page.ts";

test("a blocked renderer is terminated on the same session and probed again", async () => {
  const { channel, target } = page(NEVER);
  blockedOnce(channel);
  const result = await resolveFunctionLocator(target, request({ timeoutMs: 20 }), {
    probeTimeoutMs: 20,
  });
  expect(result).toMatchObject({
    status: "error",
    error: { message: "The locator function did not finish within 20 ms." },
    deadline: { timeoutMs: 20, blocked: true, terminated: true, tabResponsive: true },
  });
  expect(channel.sentOf("Runtime.terminateExecution")).toEqual([
    { method: "Runtime.terminateExecution", sessionId: "S1" },
  ]);
});

test("a conversion that blocks the renderer is cut at the same deadline", async () => {
  const { channel, target } = page(object("raw", "array"));
  channel.replies.set("Runtime.callFunctionOn", (params) =>
    params?.objectId === undefined ? object("raw", "array") : NEVER,
  );
  blockedOnce(channel);
  const result = await resolveFunctionLocator(target, request({ timeoutMs: 20 }), {
    probeTimeoutMs: 20,
  });
  expect(result).toMatchObject({
    status: "error",
    deadline: { timeoutMs: 20, blocked: true, terminated: true, tabResponsive: true },
  });
  expect(channel.sentOf("Runtime.terminateExecution")).toHaveLength(1);
}, 2_000);

test("a locator result that arrives after the deadline is never converted", async () => {
  let settle: (reply: unknown) => void = () => undefined;
  const late = new Promise((resolve) => {
    settle = resolve;
  });
  const { channel, target } = page(late);
  const result = await resolveFunctionLocator(target, request({ timeoutMs: 10 }));
  expect(result.deadline).toMatchObject({ blocked: false, terminated: false });
  const before = channel.sent.length;
  settle(object("late", "array"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = channel.sent.slice(before).map(({ method }) => method);
  expect(after).not.toContain("Runtime.callFunctionOn");
});

test("a renderer that still answers is not terminated, and one that never does is unresponsive", async () => {
  const awaiting = page(NEVER);
  const pending = await resolveFunctionLocator(awaiting.target, request({ timeoutMs: 10 }));
  expect(pending.deadline).toEqual({
    timeoutMs: 10,
    blocked: false,
    terminated: false,
    tabResponsive: true,
  });
  expect(awaiting.channel.sentOf("Runtime.terminateExecution")).toEqual([]);

  const stuck = page(NEVER);
  stuck.channel.replies.set("Runtime.evaluate", (params) =>
    params?.expression === "1+1" ? NEVER : object("scope"),
  );
  stuck.channel.replies.set("Runtime.terminateExecution", () => NEVER);
  const hung = await resolveFunctionLocator(stuck.target, request({ timeoutMs: 10 }), {
    probeTimeoutMs: 10,
  });
  expect(hung.deadline).toEqual({
    timeoutMs: 10,
    blocked: true,
    terminated: false,
    tabResponsive: false,
  });
});

test("releasing handles of a renderer that never answers does not hang", async () => {
  const stuck = page(object("el", "node"), ["el"]);
  stuck.channel.replies.set("Runtime.releaseObject", () => NEVER);
  stuck.channel.replies.set("Runtime.releaseObjectGroup", () => NEVER);
  const options = { probeTimeoutMs: 10 };
  const matched = await resolveFunctionLocator(stuck.target, request(), options);
  await matched.release();
  const none = page({ result: { type: "object", subtype: "null" } });
  none.channel.replies.set("Runtime.releaseObjectGroup", () => NEVER);
  expect((await resolveFunctionLocator(none.target, request(), options)).status).toBe("not-found");
}, 2_000);
