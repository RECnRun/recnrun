import { describe, expect, test } from "vite-plus/test";
import { retrying } from "./site/retry.js";

const script = (...codes: Array<string | null>) => {
  const calls: number[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const attempt = async () => {
    calls.push(index);
    const code = codes[Math.min(index, codes.length - 1)];
    index += 1;
    return code === null ? { ok: true } : { ok: false, code };
  };
  const sleep = async (ms: number) => void sleeps.push(ms);
  return { attempt, sleep, calls, sleeps };
};

describe("retrying", () => {
  test("retries CLAIMED, ACTIVE and CLEANUP with backoff until it starts", async () => {
    const run = script("CLAIMED", "ACTIVE", "CLEANUP", null);
    expect(await retrying(run.attempt, { sleep: run.sleep })).toEqual({ ok: true });
    expect(run.sleeps).toEqual([250, 500, 1000]);
  });

  test("stops after four retries and returns the last retryable refusal", async () => {
    const run = script("CLAIMED");
    expect(await retrying(run.attempt, { sleep: run.sleep })).toEqual({
      ok: false,
      code: "CLAIMED",
    });
    expect(run.calls).toHaveLength(5);
    expect(run.sleeps).toEqual([250, 500, 1000, 2000]);
  });

  test("shows any other refusal verbatim at once", async () => {
    for (const code of ["ORIGIN_DENIED", "TARGET_OFF_POLICY", "TAB_FAILED", "RATE_LIMITED"]) {
      const run = script(code);
      expect(await retrying(run.attempt, { sleep: run.sleep })).toEqual({ ok: false, code });
      expect(run.calls).toHaveLength(1);
      expect(run.sleeps).toEqual([]);
    }
  });

  test("a RATE_LIMITED caused by the retries never replaces the real refusal", async () => {
    const run = script("ACTIVE", "RATE_LIMITED");
    expect(await retrying(run.attempt, { sleep: run.sleep })).toEqual({
      ok: false,
      code: "ACTIVE",
    });
  });

  test("a different refusal after a retry is shown verbatim", async () => {
    const run = script("CLAIMED", "ORIGIN_DENIED");
    expect(await retrying(run.attempt, { sleep: run.sleep })).toEqual({
      ok: false,
      code: "ORIGIN_DENIED",
    });
  });
});
