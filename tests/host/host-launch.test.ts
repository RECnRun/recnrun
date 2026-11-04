import { describe, expect, test } from "vite-plus/test";
import { launchOnRoot } from "./fixtures/host-launch.ts";

/** A fake Chrome on a root: every call is logged in order. */
function fake({ launchFails = false, afterFails = false } = {}) {
  const calls: string[] = [];
  const steps = {
    launch: () =>
      launchFails
        ? Promise.reject(new Error("launch failed"))
        : (calls.push("launch"), Promise.resolve({ pid: 42 })),
    after: () =>
      afterFails
        ? (calls.push("after"), Promise.reject(new Error("Browser.getVersion failed")))
        : (calls.push("after"), Promise.resolve()),
    stop: ({ pid }: { pid: number }) => (calls.push(`stop ${pid}`), Promise.resolve()),
    removeRoot: () => (calls.push("removeRoot"), Promise.resolve()),
  };
  return { calls, steps };
}

// Codex P1 finding 3: a failure after the launch must not delete the root under a running Chrome.
describe("launchOnRoot", () => {
  test("hands out the launched Chrome and keeps its root when every step succeeds", async () => {
    const { calls, steps } = fake();
    await expect(launchOnRoot(steps)).resolves.toEqual({ pid: 42 });
    expect(calls).toEqual(["launch", "after"]);
  });

  test("stops the launched Chrome before removing the root when a later step fails", async () => {
    const { calls, steps } = fake({ afterFails: true });
    await expect(launchOnRoot(steps)).rejects.toThrow("Browser.getVersion failed");
    expect(calls).toEqual(["launch", "after", "stop 42", "removeRoot"]);
  });

  test("removes the root with nothing to stop when the launch itself fails", async () => {
    const { calls, steps } = fake({ launchFails: true });
    await expect(launchOnRoot(steps)).rejects.toThrow("launch failed");
    expect(calls).toEqual(["removeRoot"]);
  });

  test("still removes the root when stopping Chrome fails, and reports the stop", async () => {
    const { calls, steps } = fake({ afterFails: true });
    const failingStop = () => (calls.push("stop failed"), Promise.reject(new Error("no exit")));
    await expect(launchOnRoot({ ...steps, stop: failingStop })).rejects.toThrow("no exit");
    expect(calls).toEqual(["launch", "after", "stop failed", "removeRoot"]);
  });
});
