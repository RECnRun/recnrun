import { describe, expect, test, vi } from "vite-plus/test";
import { createOnboarding, POLL_MS } from "@/onboarding/service";
import type { OnboardingPorts, OnboardingSnapshot } from "@/onboarding/service";
import type { Operation } from "@/onboarding/state";

const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const BOOT1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const BOOT2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const NOW = 1_800_000_000_000;

const statusText = (over: object = {}) =>
  JSON.stringify({
    operationId: OP,
    step: "create-base",
    state: "running",
    message: "",
    clones: [],
    updatedAt: NOW,
    ...over,
  });
const clone = (name: string, instanceId: string, boot: string) => ({
  name,
  instanceId,
  boot,
  acked: boot !== "",
});
const registryText = (boots: Record<string, string>) =>
  JSON.stringify({
    version: 1,
    namespace: "lab-1",
    writtenAt: NOW,
    launcher: { boot: "99999999-9999-4999-8999-999999999999" },
    roots: { r1: "/Downloads" },
    peers: Object.fromEntries(
      Object.entries(boots).map(([id, boot]) => [
        id,
        {
          profileId: id,
          displayName: id.slice(0, 4),
          fingerprint: "AB:CD",
          root: "r1",
          lastSeenAt: NOW,
          expiresAt: NOW + 60_000,
          boot,
        },
      ]),
    ),
  });

function scene(stored?: Operation) {
  const texts: { status?: string; registry?: string } = {};
  const sent: unknown[] = [];
  const writes: Operation[] = [];
  let tick: (() => void) | undefined;
  const stopped = vi.fn();
  const ports: OnboardingPorts = {
    store: { read: async () => stored, write: async (op) => void writes.push(op) },
    readTexts: async () => ({ ...texts }),
    send: async (message) => void sent.push(message),
    master: async () => true,
    newId: () => OP,
    every: (run, ms) => {
      expect(ms).toBe(POLL_MS);
      tick = run;
      return stopped;
    },
    now: () => NOW,
  };
  const seen: OnboardingSnapshot[] = [];
  const onboarding = createOnboarding(ports);
  const stop = onboarding.watch((snapshot) => seen.push(snapshot));
  const last = () => seen.at(-1);
  const poll = async () => {
    tick?.();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { onboarding, texts, sent, writes, seen, last, poll, stop, stopped, ports };
}

describe("createOnboarding", () => {
  test("starts idle, writes the choice once, and asks the background with a fresh operation", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.phase).toBe("idle"));
    await s.onboarding.request("/Bases", 2);
    const choice = { operationId: OP, basesDir: "/Bases", baseName: "base-v1", clones: 2 };
    expect(s.sent).toEqual([{ type: "POC_PREPARE_WORKERS", op: "request", choice }]);
    expect(s.writes).toEqual([choice]);
    expect(s.last()).toMatchObject({ phase: "requested", failure: "" });
  });

  test("refuses a bad choice without asking the background", async () => {
    const s = scene();
    await vi.waitFor(() => expect(s.last()?.phase).toBe("idle"));
    await s.onboarding.request("relative", 2);
    await s.onboarding.request("/Bases", 9);
    expect(s.sent).toEqual([]);
    expect(s.last()?.failure).not.toBe("");
    expect(s.last()?.phase).toBe("idle");
  });

  test("shows the background's refusal and stays idle", async () => {
    const s = scene();
    s.ports.send = async () => {
      throw new Error("Only the master prepares workers.");
    };
    await vi.waitFor(() => expect(s.last()?.phase).toBe("idle"));
    await s.onboarding.request("/Bases", 2);
    expect(s.last()).toMatchObject({ phase: "idle", failure: "Only the master prepares workers." });
    expect(s.writes).toEqual([]);
  });

  test("resumes the stored operation and is done only after the registry lists every clone", async () => {
    const s = scene({ operationId: OP, basesDir: "/Bases", baseName: "base-v1", clones: 2 });
    s.texts.status = statusText({
      step: "done",
      state: "done",
      clones: [clone("w1", W1, BOOT1), clone("w2", W2, BOOT2)],
    });
    s.texts.registry = registryText({ [W1]: BOOT1 });
    await vi.waitFor(() => expect(s.last()?.phase).toBe("running"));
    s.texts.registry = registryText({ [W1]: BOOT1, [W2]: BOOT2 });
    await s.poll();
    await vi.waitFor(() => expect(s.last()?.phase).toBe("done"));
    expect(s.last()?.clones.map((row) => row.linked)).toEqual([true, true]);
    expect(s.stopped).toHaveBeenCalled();
  });

  test("retry asks the background and waits for a newer status", async () => {
    const s = scene({ operationId: OP, basesDir: "/Bases", baseName: "base-v1", clones: 2 });
    s.texts.status = statusText({ state: "error", message: "exit 73" });
    await vi.waitFor(() => expect(s.last()?.phase).toBe("error"));
    await s.onboarding.retry();
    expect(s.sent).toEqual([{ type: "POC_PREPARE_WORKERS", op: "retry", operationId: OP }]);
    expect(s.last()?.phase).toBe("retrying");
    s.texts.status = statusText({ updatedAt: NOW + 1000, step: "create-clone" });
    await s.poll();
    await vi.waitFor(() => expect(s.last()?.phase).toBe("running"));
  });

  test("ignores unreadable and malformed files, and stops polling with the last watcher", async () => {
    const s = scene({ operationId: OP, basesDir: "/Bases", baseName: "base-v1", clones: 1 });
    s.texts.status = "not json";
    s.texts.registry = "{";
    await vi.waitFor(() => expect(s.last()?.phase).toBe("requested"));
    s.stop();
    expect(s.stopped).toHaveBeenCalled();
  });

  test("answers whether this profile is the master", async () => {
    const s = scene();
    expect(await s.onboarding.isMaster()).toBe(true);
    s.ports.master = async () => {
      throw new Error("unreadable");
    };
    expect(await createOnboarding(s.ports).isMaster()).toBe(false);
  });
});
