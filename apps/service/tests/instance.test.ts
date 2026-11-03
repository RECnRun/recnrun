import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServiceStateStore, type ServiceStateStore } from "@recnrun/persistence";
import type { ServiceState } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { claimInstance, InstanceStartingError, isProcessAlive } from "@/instance";

const created = "2026-11-02T10:00:00.000Z";
const state: ServiceState = {
  schemaVersion: 1,
  pid: 4242,
  port: 4700,
  token: "s".repeat(43),
  startedAt: created,
  serviceVersion: "0.0.0",
};

let home = "";
let store: ServiceStateStore;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-instance-"));
  store = openServiceStateStore({ home });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const lockBy = (pid: number) =>
  store.createLock({ schemaVersion: 1, pid, nonce: "old", createdAt: created });
const claim = (overrides: Partial<Parameters<typeof claimInstance>[0]> = {}) =>
  claimInstance({
    store,
    pid: 7,
    answers: async () => true,
    isAlive: () => true,
    now: () => Date.parse(created) + 1000,
    pause: async () => undefined,
    ...overrides,
  });

test("claims a free lock", async () => {
  expect(await claim()).toMatchObject({ kind: "claimed" });
  expect(await store.readLock()).toMatchObject({ kind: "held", lock: { pid: 7 } });
});

test("finds the live instance that answers", async () => {
  await lockBy(state.pid);
  await store.writeState(state);
  expect(await claim()).toEqual({ kind: "running", state });
  expect(await store.readLock()).toMatchObject({ kind: "held", lock: { pid: state.pid } });
});

test.each([
  ["its process is dead", { isAlive: () => false }],
  ["its port no longer answers", { answers: async () => false }],
])("recovers a lock when %s", async (_name, overrides) => {
  await lockBy(state.pid);
  await store.writeState(state);
  expect(await claim(overrides)).toMatchObject({ kind: "claimed" });
  expect(await store.readLock()).toMatchObject({ kind: "held", lock: { pid: 7 } });
});

test("recovers a lock file that is not a lock", async () => {
  await lockBy(1);
  await writeFile(store.lockPath, "{");
  expect(await claim()).toMatchObject({ kind: "claimed" });
});

test("waits for a live instance that is starting, then gives up", async () => {
  await lockBy(state.pid);
  let clock = Date.parse(created);
  const pauses: number[] = [];
  const waiting = claim({
    now: () => clock,
    pause: async (ms) => {
      pauses.push(ms);
      clock += 1000;
    },
    startupGraceMs: 60_000,
    timeoutMs: 5000,
  });
  await expect(waiting).rejects.toThrow(InstanceStartingError);
  expect(pauses.length).toBeGreaterThanOrEqual(5);
});

test("treats a live lock without service.json past the grace period as stale", async () => {
  await lockBy(state.pid);
  const late = () => Date.parse(created) + 20_000;
  expect(await claim({ now: late, startupGraceMs: 10_000 })).toMatchObject({ kind: "claimed" });
});

test("isProcessAlive tells this process from one that exited", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(spawnSync(process.execPath, ["-e", ""]).pid)).toBe(false);
});
