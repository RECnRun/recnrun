import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { bootstrap } from "@/diagnostics/bootstrap";

const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const LIMITS = { adoptMs: 100, publishMs: 1000, ackMs: 500, failureMs: 300 };
const NEVER = new Promise<never>(() => {});

type Message = { type: string; [key: string]: unknown };

/** A background that answers each message type with the next reply of its script; `NEVER` stalls. */
function background(script: Record<string, unknown[]>) {
  const send = vi.fn(async (message: unknown) => {
    const { type } = message as Message;
    return script[type]?.shift() ?? { ok: true };
  });
  const sentOf = (type: string) =>
    send.mock.calls.map(([m]) => m as Message).filter((m) => m.type === type);
  return { send, sentOf };
}

const run = (send: (message: unknown) => Promise<unknown>, adopt = async () => {}) =>
  bootstrap({
    hash: `#token=${TOKEN}`,
    adopt,
    enterTemplate: async () => {},
    send,
    limits: LIMITS,
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bootstrap bounds", () => {
  test("a stalled presence publish is retried once, then reported as a failure ack", async () => {
    const { send, sentOf } = background({ POC_PUBLISH_PRESENCE: [NEVER, NEVER] });
    const result = run(send);
    await vi.advanceTimersByTimeAsync(LIMITS.publishMs * 2);
    expect(await result).toEqual({
      ok: false,
      error: "The presence did not finish within 1 s.",
    });
    expect(sentOf("POC_PUBLISH_PRESENCE")).toHaveLength(2);
    expect(sentOf("POC_LAUNCHER_FAILURE")).toEqual([
      {
        type: "POC_LAUNCHER_FAILURE",
        token: TOKEN,
        step: "publish",
        error: "The presence did not finish within 1 s.",
      },
    ]);
    expect(sentOf("POC_LAUNCHER_ACK")).toEqual([]);
  });

  test("a transient publish failure is retried and the bootstrap still acks", async () => {
    const { send, sentOf } = background({
      POC_PUBLISH_PRESENCE: [NEVER, { ok: true }],
    });
    const result = run(send);
    await vi.advanceTimersByTimeAsync(LIMITS.publishMs);
    expect(await result).toEqual({ ok: true, token: TOKEN, acked: true });
    expect(sentOf("POC_PUBLISH_PRESENCE")).toHaveLength(2);
    expect(sentOf("POC_LAUNCHER_FAILURE")).toEqual([]);
  });

  test("a refused publish is retried once too, and the last error is reported", async () => {
    const { send, sentOf } = background({
      POC_PUBLISH_PRESENCE: [
        { ok: false, error: "The offscreen document did not answer." },
        { ok: false, error: "Second refusal." },
      ],
    });
    expect(await run(send)).toEqual({ ok: false, error: "Second refusal." });
    expect(sentOf("POC_LAUNCHER_FAILURE")).toMatchObject([
      { step: "publish", error: "Second refusal." },
    ]);
  });

  test("a stalled ack write keeps the presence and reports a failure ack for the ack step", async () => {
    const { send, sentOf } = background({ POC_LAUNCHER_ACK: [NEVER] });
    const result = run(send);
    await vi.advanceTimersByTimeAsync(LIMITS.ackMs);
    expect(await result).toEqual({
      ok: true,
      token: TOKEN,
      acked: false,
      error: "The ack did not finish within 0.5 s.",
    });
    expect(sentOf("POC_LAUNCHER_FAILURE")).toMatchObject([{ step: "ack" }]);
  });

  test("a stalled adopt is reported at the adopt step and asks for no presence", async () => {
    const { send, sentOf } = background({});
    const result = run(send, () => NEVER);
    await vi.advanceTimersByTimeAsync(LIMITS.adoptMs);
    expect(await result).toEqual({ ok: false, error: "The adoption did not finish within 0.1 s." });
    expect(sentOf("POC_PUBLISH_PRESENCE")).toEqual([]);
    expect(sentOf("POC_LAUNCHER_FAILURE")).toMatchObject([{ step: "adopt" }]);
  });

  test("the failure report is bounded too, so a dead background cannot hang the page", async () => {
    const send = vi.fn((message: unknown) =>
      (message as Message).type === "POC_PUBLISH_PRESENCE"
        ? Promise.resolve({ ok: false, error: "boom" })
        : NEVER,
    );
    const result = run(send);
    await vi.advanceTimersByTimeAsync(LIMITS.failureMs);
    expect(await result).toEqual({ ok: false, error: "boom" });
  });
});
