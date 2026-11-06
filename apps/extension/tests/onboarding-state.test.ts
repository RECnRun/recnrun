import { describe, expect, test } from "vite-plus/test";
import { INITIAL, reduce, view } from "@/onboarding/state";
import type { OnboardingEvent, OnboardingState } from "@/onboarding/state";
import type { PrepareStatus } from "@/p2p/prepare";

const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const BOOT1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const BOOT2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const operation = { operationId: OP, basesDir: "/Bases", baseName: "base-v1", clones: 2 };

const status = (overrides: Partial<PrepareStatus> = {}): PrepareStatus => ({
  operationId: OP,
  step: "create-base",
  state: "running",
  message: "",
  clones: [],
  updatedAt: 1000,
  ...overrides,
});
const clones = (acked: boolean) => [
  { name: "w1", instanceId: W1, boot: acked ? BOOT1 : "", acked },
  { name: "w2", instanceId: W2, boot: acked ? BOOT2 : "", acked },
];
const run = (...events: OnboardingEvent[]): OnboardingState => events.reduce(reduce, INITIAL);
const requested: OnboardingEvent = { type: "requested", operation };

describe("onboarding reducer", () => {
  test("starts idle and becomes requested", () => {
    expect(view(INITIAL).phase).toBe("idle");
    expect(view(run(requested)).phase).toBe("requested");
  });

  test("shows the launcher's step and state", () => {
    const state = run(requested, {
      type: "status",
      status: status({ step: "template", state: "pending-action", message: "approve" }),
    });
    expect(view(state)).toMatchObject({
      phase: "pending-action",
      step: "template",
      message: "approve",
    });
  });

  test("ignores a status of another operation or an older one", () => {
    const base = run(requested, {
      type: "status",
      status: status({ updatedAt: 2000, step: "freeze" }),
    });
    const other = reduce(base, {
      type: "status",
      status: status({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", updatedAt: 3000 }),
    });
    const older = reduce(base, {
      type: "status",
      status: status({ updatedAt: 1500, step: "install" }),
    });
    expect(other).toBe(base);
    expect(older).toBe(base);
  });

  test("ignores a status before any request", () => {
    expect(view(run({ type: "status", status: status() })).phase).toBe("idle");
  });

  test("is done only when every clone is acked and in the registry with its boot", () => {
    const done = status({ step: "done", state: "done", clones: clones(true), updatedAt: 5000 });
    const afterStatus = run(requested, { type: "status", status: done });
    expect(view(afterStatus).phase).toBe("running");
    const half = reduce(afterStatus, { type: "registry", peers: { [W1]: { boot: BOOT1 } } });
    expect(view(half).phase).toBe("running");
    const wrongBoot = reduce(half, {
      type: "registry",
      peers: { [W1]: { boot: BOOT1 }, [W2]: { boot: BOOT1 } },
    });
    expect(view(wrongBoot).phase).toBe("running");
    const full = reduce(half, {
      type: "registry",
      peers: { [W1]: { boot: BOOT1 }, [W2]: { boot: BOOT2 } },
    });
    const finished = view(full);
    expect(finished.phase).toBe("done");
    expect(finished.clones.map((it) => it.linked)).toEqual([true, true]);
  });

  test("a done status with fewer clones than asked is not done", () => {
    const state = run(
      requested,
      {
        type: "status",
        status: status({
          step: "done",
          state: "done",
          clones: clones(true).slice(0, 1),
          updatedAt: 5000,
        }),
      },
      { type: "registry", peers: { [W1]: { boot: BOOT1 } } },
    );
    expect(view(state).phase).toBe("running");
  });

  test("a done status listing one worker twice is not done", () => {
    const one = clones(true).slice(0, 1);
    const state = run(
      requested,
      {
        type: "status",
        status: status({ step: "done", state: "done", clones: [...one, ...one], updatedAt: 5000 }),
      },
      { type: "registry", peers: { [W1]: { boot: BOOT1 } } },
    );
    expect(view(state).phase).toBe("running");
  });

  test("a done status whose workers are not w1 to wN is not done", () => {
    const renamed = clones(true).map((clone, index) => ({ ...clone, name: `w${index + 2}` }));
    const state = run(
      requested,
      {
        type: "status",
        status: status({ step: "done", state: "done", clones: renamed, updatedAt: 5000 }),
      },
      { type: "registry", peers: { [W1]: { boot: BOOT1 }, [W2]: { boot: BOOT2 } } },
    );
    expect(view(state).phase).toBe("running");
  });

  test("an unacked clone is never linked even when its id is in the registry", () => {
    const state = run(
      requested,
      { type: "status", status: status({ step: "open-clone", clones: clones(false) }) },
      { type: "registry", peers: { [W1]: { boot: "" } } },
    );
    expect(view(state).clones.map((it) => it.linked)).toEqual([false, false]);
  });

  test("error stays until retry, which waits for a newer status", () => {
    const failed = run(requested, {
      type: "status",
      status: status({ state: "error", message: "exit 73", updatedAt: 2000 }),
    });
    expect(view(failed)).toMatchObject({ phase: "error", message: "exit 73" });
    const retried = reduce(failed, { type: "retry" });
    expect(view(retried).phase).toBe("retrying");
    expect(
      view(
        reduce(retried, {
          type: "status",
          status: status({ state: "error", message: "exit 73", updatedAt: 2000 }),
        }),
      ).phase,
    ).toBe("retrying");
    expect(
      view(reduce(retried, { type: "status", status: status({ updatedAt: 3000 }) })).phase,
    ).toBe("running");
  });

  test("retry outside an error changes nothing", () => {
    const running = run(requested, { type: "status", status: status() });
    expect(reduce(running, { type: "retry" })).toBe(running);
  });

  test("a new request replaces the last operation", () => {
    const first = run(requested, { type: "status", status: status({ updatedAt: 9000 }) });
    const next = reduce(first, {
      type: "requested",
      operation: { ...operation, operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });
    expect(next.status).toBeUndefined();
    expect(view(next).phase).toBe("requested");
  });
});
