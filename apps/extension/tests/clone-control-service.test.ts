import { describe, expect, test, vi } from "vite-plus/test";
import { createCloneControl, NO_ANSWER_MS, POLL_MS } from "@/onboarding/clone-control-service";
import type { CloneControlPorts, CloneControlSnapshot } from "@/onboarding/clone-control-service";

const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const W1 = "11111111-1111-4111-8111-111111111111";
const BOOT = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const NOW = 1_800_000_000_000;

const clonesText = (state = "open", mode = "headless") =>
  JSON.stringify({
    clones: [{ name: "w1", instanceId: W1, state, mode, boot: state === "closed" ? "" : BOOT }],
    updatedAt: NOW,
  });
const registryText = (boot: string) =>
  JSON.stringify({
    version: 1,
    namespace: "lab-1",
    writtenAt: NOW,
    launcher: { boot: "99999999-9999-4999-8999-999999999999" },
    roots: { r1: "/Downloads" },
    peers: {
      [W1]: {
        profileId: W1,
        displayName: "w1",
        fingerprint: "AB:CD",
        root: "r1",
        lastSeenAt: NOW,
        expiresAt: NOW + 60_000,
        boot,
      },
    },
  });
const statusText = (state: string, over: object = {}) =>
  JSON.stringify({
    requestId: REQ,
    action: "close",
    instanceId: W1,
    state,
    message: "closed w1",
    updatedAt: NOW,
    ...over,
  });

function scene(master = true) {
  const texts: { clones?: string; status?: string; registry?: string } = { clones: clonesText() };
  const sent: unknown[] = [];
  const ids = [REQ, REQ2];
  const clock = { now: NOW };
  let tick: (() => void) | undefined;
  const stopped = vi.fn();
  const ports: CloneControlPorts = {
    readTexts: async () => ({ ...texts }),
    send: async (message) => void sent.push(message),
    master: async () => master,
    newId: () => ids.shift() ?? REQ2,
    every: (run, ms) => {
      expect(ms).toBe(POLL_MS);
      tick = run;
      return stopped;
    },
    now: () => clock.now,
  };
  const seen: CloneControlSnapshot[] = [];
  const control = createCloneControl(ports);
  const stop = control.watch((snapshot) => seen.push(snapshot));
  const last = () => seen.at(-1);
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const poll = async () => {
    tick?.();
    await settle();
    await settle();
  };
  return { control, texts, sent, seen, last, poll, stop, stopped, clock, settle, ports };
}

describe("createCloneControl", () => {
  test("lists the clones the launcher published", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    expect(s.last()?.clones[0]).toMatchObject({ name: "w1", state: "open", mode: "headless" });
    expect(s.last()?.pending).toBeUndefined();
  });

  test("keeps the last list while the file is unreadable", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    s.texts.clones = "{";
    await s.poll();
    expect(s.last()?.clones).toHaveLength(1);
  });

  test("ask sends one message with a fresh request id and holds the clone pending", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "reopen-visible");
    expect(s.sent).toEqual([
      {
        type: "POC_CLONE_CONTROL",
        choice: { requestId: REQ, action: "reopen-visible", instanceId: W1 },
      },
    ]);
    expect(s.last()?.pending).toEqual({ requestId: REQ, action: "reopen-visible", instanceId: W1 });
  });

  test("ask while a request is pending sends nothing", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    await s.control.ask(W1, "open-visible");
    expect(s.sent).toHaveLength(1);
  });

  test.each(["done", "refused", "error"])(
    "a %s answer clears pending and shows the message",
    async (state) => {
      const s = scene();
      await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
      await s.control.ask(W1, "close");
      s.texts.status = statusText(state);
      await s.poll();
      expect(s.last()?.pending).toBeUndefined();
      expect(s.last()?.message).toBe(`${state}: closed w1`);
    },
  );

  test("a running answer keeps the request pending", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.texts.status = statusText("running");
    await s.poll();
    expect(s.last()?.pending?.requestId).toBe(REQ);
  });

  test("an answer to another request is ignored", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.texts.status = statusText("done", { requestId: REQ2 });
    await s.poll();
    expect(s.last()?.pending?.requestId).toBe(REQ);
  });

  test("no answer within the window clears pending and says so", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.clock.now += NO_ANSWER_MS + 1;
    await s.poll();
    expect(s.last()?.pending).toBeUndefined();
    expect(s.last()?.message).toMatch(/No answer from the launcher/);
  });

  test("a refused write shows why and leaves nothing pending", async () => {
    const s = scene();
    s.ports.send = async () => {
      throw new Error("Only the master controls clones.");
    };
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    expect(s.last()?.pending).toBeUndefined();
    expect(s.last()?.failure).toBe("Only the master controls clones.");
  });

  test("a new ask can follow a terminal answer", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.texts.status = statusText("done");
    await s.poll();
    await s.control.ask(W1, "open-visible");
    expect(s.sent).toHaveLength(2);
    expect(s.last()?.pending?.requestId).toBe(REQ2);
  });

  test("stops polling when the last listener leaves", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    s.stop();
    expect(s.stopped).toHaveBeenCalled();
  });

  test("isMaster answers the profile's role", async () => {
    expect(await scene(false).control.isMaster()).toBe(false);
    expect(await scene(true).control.isMaster()).toBe(true);
  });
});

describe("createCloneControl reservations and outcomes", () => {
  test("two quick asks send one message and reserve pending before the send settles", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    let release: () => void = () => {};
    s.ports.send = (message) => {
      s.sent.push(message);
      return new Promise<void>((resolve) => (release = resolve));
    };
    const first = s.control.ask(W1, "close");
    const second = s.control.ask(W1, "open-visible");
    expect(s.last()?.pending?.requestId).toBe(REQ);
    release();
    await Promise.all([first, second]);
    expect(s.sent).toHaveLength(1);
  });

  test("a stale rejection leaves a newer reservation alone", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    let rejectFirst: (error: Error) => void = () => {};
    s.ports.send = () => new Promise<void>((_, reject) => (rejectFirst = reject));
    const first = s.control.ask(W1, "close");
    s.clock.now += NO_ANSWER_MS + 1;
    await s.poll();
    expect(s.last()?.pending).toBeUndefined();
    s.ports.send = async (message) => void s.sent.push(message);
    await s.control.ask(W1, "open-visible");
    expect(s.last()?.pending?.requestId).toBe(REQ2);
    rejectFirst(new Error("late"));
    await first;
    expect(s.last()?.pending?.requestId).toBe(REQ2);
    expect(s.last()?.failure).toBe("");
  });

  test("a rejected send releases the reservation", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    s.ports.send = async () => {
      throw new Error("no");
    };
    await s.control.ask(W1, "close");
    expect(s.last()?.pending).toBeUndefined();
    expect(s.last()?.failure).toBe("no");
  });

  test.each(["done", "refused", "error"])("a %s answer is kept as an outcome", async (state) => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.texts.status = statusText(state);
    await s.poll();
    expect(s.last()?.outcome).toEqual({ state, message: "closed w1" });
  });

  test("no answer is an unanswered outcome", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.clones).toHaveLength(1));
    await s.control.ask(W1, "close");
    s.clock.now += NO_ANSWER_MS + 1;
    await s.poll();
    expect(s.last()?.outcome?.state).toBe("unanswered");
  });

  test("a clone is linked when the registry boot equals its boot", async () => {
    const s = scene();
    s.texts.registry = registryText(BOOT);
    await s.poll();
    expect(s.last()?.clones[0]?.linked).toBe(true);
    s.texts.registry = registryText("c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3");
    await s.poll();
    expect(s.last()?.clones[0]?.linked).toBe(false);
    s.texts.registry = undefined;
    await s.poll();
    expect(s.last()?.clones[0]?.linked).toBe(false);
  });
});
