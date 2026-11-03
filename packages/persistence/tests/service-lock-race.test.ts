import type * as fs from "node:fs/promises";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceLock } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { openServiceStateStore } from "../src/index.ts";

interface Pause {
  path: string;
  reached: () => void;
  released: Promise<void>;
}
const gate = vi.hoisted(() => ({ pause: undefined as Pause | undefined }));

// Holds back one read of the lock after it happened, so a remover acts on what it saw earlier.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    const pause = gate.pause;
    if (pause !== undefined && args[0] === pause.path) {
      gate.pause = undefined;
      pause.reached();
      await pause.released;
    }
    return result;
  };
  return { ...actual, readFile };
});

function pauseNextRead(path: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>(
    (resolve) => (gate.pause = { path, reached: resolve, released }),
  );
  return { reached, release };
}

const lock = (nonce: string): ServiceLock => ({
  schemaVersion: 1,
  pid: 4242,
  nonce,
  createdAt: "2026-11-02T10:00:00.000Z",
});

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-lock-race-"));
});
afterEach(async () => {
  gate.pause = undefined;
  await rm(home, { recursive: true, force: true });
});

async function ageRemovalClaims() {
  const folder = join(home, ".recnrun");
  const old = new Date(Date.now() - 60_000);
  for (const name of await readdir(folder)) {
    if (name.endsWith(".claim")) await utimes(join(folder, name), old, old);
  }
}

test("a second remover of the same stale lock backs off while the first one works", async () => {
  const [first, second] = [openServiceStateStore({ home }), openServiceStateStore({ home })];
  await first.createLock(lock("stale"));
  const paused = pauseNextRead(first.lockPath);
  const removal = first.removeLock("stale");
  await paused.reached;
  expect(await second.removeLock("stale")).toBe(false);
  paused.release();
  expect(await removal).toBe(true);
  expect(await second.readLock()).toEqual({ kind: "absent" });
});

test("a remover that stalled past its claim never deletes the lock that replaced the stale one", async () => {
  const [late, starter] = [openServiceStateStore({ home }), openServiceStateStore({ home })];
  await starter.createLock(lock("stale"));
  const paused = pauseNextRead(late.lockPath);
  const lateRemoval = late.removeLock("stale");
  await paused.reached;
  await ageRemovalClaims();
  expect(await starter.removeLock("stale")).toBe(true);
  expect(await starter.createLock(lock("fresh"))).toBe(true);
  paused.release();
  expect(await lateRemoval).toBe(false);
  expect(await starter.readLock()).toEqual({ kind: "held", lock: lock("fresh") });
  expect((await readdir(join(home, ".recnrun"))).filter((name) => name.startsWith("."))).toEqual(
    [],
  );
});
