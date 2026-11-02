import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLock, ServiceState } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openServiceStateStore } from "../src/index.ts";

const state: ServiceState = {
  schemaVersion: 1,
  pid: 4242,
  port: 47_123,
  token: "t".repeat(43),
  startedAt: "2026-11-02T10:00:00.000Z",
  serviceVersion: "0.0.0",
};
const lock: ServiceLock = {
  schemaVersion: 1,
  pid: 4242,
  nonce: "n-1",
  createdAt: "2026-11-02T10:00:00.000Z",
};

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-service-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("keeps its files in <home>/.recnrun", () => {
  const store = openServiceStateStore({ home });
  expect(store.statePath).toBe(join(home, ".recnrun", "service.json"));
  expect(store.lockPath).toBe(join(home, ".recnrun", "service.lock"));
  expect(store.logsFolder).toBe(join(home, ".recnrun", "logs"));
});

test("writes service.json atomically at mode 0600 in a 0700 folder and reads it back", async () => {
  const store = openServiceStateStore({ home });
  expect(await store.readState()).toBeUndefined();
  await store.writeState(state);
  expect(await store.readState()).toEqual(state);
  expect(await mode(store.statePath)).toBe(0o600);
  expect(await mode(join(home, ".recnrun"))).toBe(0o700);
  expect((await readdir(join(home, ".recnrun"))).filter((name) => name.endsWith(".tmp"))).toEqual(
    [],
  );
});

test("refuses to write an invalid state", async () => {
  const store = openServiceStateStore({ home });
  await expect(store.writeState({ ...state, token: "short" })).rejects.toThrow(/token/);
  expect(await store.readState()).toBeUndefined();
});

test("reads an unreadable service.json as no state, since the running service rewrites it", async () => {
  const store = openServiceStateStore({ home });
  await mkdir(join(home, ".recnrun"), { recursive: true });
  await writeFile(store.statePath, "{ not json");
  expect(await store.readState()).toBeUndefined();
  await writeFile(store.statePath, JSON.stringify({ ...state, port: 0 }));
  expect(await store.readState()).toBeUndefined();
});

test("removes service.json only for the pid that wrote it", async () => {
  const store = openServiceStateStore({ home });
  await store.writeState(state);
  expect(await store.removeState(1)).toBe(false);
  expect(await store.readState()).toEqual(state);
  expect(await store.removeState(state.pid)).toBe(true);
  expect(await store.readState()).toBeUndefined();
  expect(await store.removeState(state.pid)).toBe(false);
});

test("creates the lock exclusively at mode 0600", async () => {
  const store = openServiceStateStore({ home });
  expect(await store.readLock()).toEqual({ kind: "absent" });
  expect(await store.createLock(lock)).toBe(true);
  expect(await store.createLock({ ...lock, nonce: "n-2" })).toBe(false);
  expect(await store.readLock()).toEqual({ kind: "held", lock });
  expect(await mode(store.lockPath)).toBe(0o600);
});

test("removes the lock only when it still holds the expected nonce", async () => {
  const store = openServiceStateStore({ home });
  await store.createLock(lock);
  expect(await store.removeLock("n-2")).toBe(false);
  expect(await store.readLock()).toEqual({ kind: "held", lock });
  expect(await store.removeLock("n-1")).toBe(true);
  expect(await store.readLock()).toEqual({ kind: "absent" });
  expect(await store.removeLock("n-1")).toBe(false);
});

test("reports a lock it cannot read as invalid and removes it on request", async () => {
  const store = openServiceStateStore({ home });
  await mkdir(join(home, ".recnrun"), { recursive: true });
  await writeFile(store.lockPath, "garbage");
  expect(await store.readLock()).toEqual({ kind: "invalid" });
  expect(await store.removeLock(undefined)).toBe(true);
  expect(await readFile(store.lockPath, "utf8").catch(() => "gone")).toBe("gone");
});
