import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { connectPipe } from "./browser/fixtures/cdp-client.ts";

type Outcome =
  | { state: "pending" }
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; message: string };

function outcomeOf(promise: Promise<unknown>): { current: Outcome } {
  const tracked: { current: Outcome } = { current: { state: "pending" } };
  promise.then(
    (value) => (tracked.current = { state: "resolved", value }),
    (error: unknown) =>
      (tracked.current = { state: "rejected", message: (error as Error).message }),
  );
  return tracked;
}

/** How `promise` settled within `ms` of real time; a request that never settles stays pending. */
async function within(promise: Promise<unknown>, ms = 50): Promise<Outcome> {
  const tracked = outcomeOf(promise);
  await Promise.race([promise.catch(() => undefined), delay(ms)]);
  return tracked.current;
}

function pipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, client: connectPipe(input, output) };
}

function reply(output: PassThrough, message: object): void {
  output.write(`${JSON.stringify(message)}\0`);
}

const closed = (method: string): Outcome => ({
  state: "rejected",
  message: `${method}: CDP connection closed`,
});

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

describe("CDP client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves a reply and rejects a CDP error with the method", async () => {
    const { output, client } = pipe();
    const version = client.send("Browser.getVersion");
    const refused = client.send("Target.attachToTarget");
    reply(output, { id: 1, result: { product: "Chrome" } });
    reply(output, { id: 2, error: { message: "No target" } });
    expect(await within(version)).toEqual({ state: "resolved", value: { product: "Chrome" } });
    expect(await within(refused)).toEqual({
      state: "rejected",
      message: "Target.attachToTarget: No target",
    });
  });

  test("rejects pending requests when Chrome's end of the pipe ends", async () => {
    const { output, client } = pipe();
    const request = client.send("Target.getTargets");
    output.end();
    expect(await within(request)).toEqual(closed("Target.getTargets"));
  });

  test("rejects pending requests when the pipe errors", async () => {
    const { output, client } = pipe();
    const request = client.send("Target.getTargets");
    output.destroy(new Error("read EPIPE"));
    expect(await within(request)).toEqual(closed("Target.getTargets"));
  });

  test("rejects pending requests on close and later sends at once, writing nothing", async () => {
    const { input, client } = pipe();
    const writeErrors: string[] = [];
    input.on("error", (error) => writeErrors.push(error.message));
    const request = client.send("Target.getTargets");
    client.close();
    expect(await within(request)).toEqual(closed("Target.getTargets"));
    expect(await within(client.send("Browser.getVersion"))).toEqual(closed("Browser.getVersion"));
    expect(writeErrors).toEqual([]);
  });

  test("rejects a request Chrome never answers after 30 s and ignores a late reply", async () => {
    vi.useFakeTimers();
    const { output, client } = pipe();
    const request = outcomeOf(client.send("Runtime.evaluate"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request.current).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(1);
    expect(request.current).toEqual({
      state: "rejected",
      message: "Runtime.evaluate: no reply within 30000 ms",
    });
    reply(output, { id: 1, result: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.current.state).toBe("rejected");
  });

  test("takes a per-command deadline and clears it on reply", async () => {
    vi.useFakeTimers();
    const { output, client } = pipe();
    const slow = outcomeOf(client.send("Runtime.evaluate", {}, undefined, { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slow.current).toEqual({
      state: "rejected",
      message: "Runtime.evaluate: no reply within 1000 ms",
    });
    const answered = client.send("Browser.getVersion");
    reply(output, { id: 2, result: {} });
    await answered;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("deadlines do not keep the Node process alive", () => {
    const before = activeTimeouts();
    const { client } = pipe();
    void client.send("Browser.getVersion").catch(() => undefined);
    expect(activeTimeouts()).toBe(before);
    client.close();
  });
});
