import { spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { EgressForbiddenError } from "../../apps/service/src/index.ts";
import {
  openFlowStore,
  openServiceStateStore,
  readJournal,
} from "../../packages/persistence/src/index.ts";
import { command, runNode, send, startFresh, tempHome } from "./helpers.ts";

let home = "";
beforeEach(async () => {
  home = await tempHome();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const token = "t".repeat(43);
const at = "2026-11-02T10:00:00.000Z";

/** A port nothing listens on any more. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address !== "object") throw new Error("No port.");
  return address.port;
}

async function leaveLock(pid: number) {
  const store = openServiceStateStore({ home });
  await store.createLock({ schemaVersion: 1, pid, nonce: "old", createdAt: at });
  const port = await closedPort();
  await store.writeState({
    schemaVersion: 1,
    pid,
    port,
    token,
    startedAt: at,
    serviceVersion: "0.0.0",
  });
  return store;
}

test.each([
  ["a dead process", () => spawnSync(process.execPath, ["-e", ""]).pid],
  ["a live process whose port no longer answers", () => process.pid],
])("a lock left by %s is recovered", async (_name, pidOf) => {
  const store = await leaveLock(pidOf());
  const service = await startFresh(home);
  try {
    expect(await store.readLock()).toMatchObject({ kind: "held", lock: { pid: process.pid } });
    expect(await store.readState()).toMatchObject({ pid: process.pid, port: service.port });
    expect((await command(service, { requestId: "r", command: "health", params: {} })).status).toBe(
      200,
    );
  } finally {
    await service.stop();
  }
});

test("bin.ts serves once per user and SIGTERM stops it cleanly", async () => {
  const store = openServiceStateStore({ home });
  const first = runNode("apps/service/src/bin.ts", [], home);
  const started = JSON.parse(await first.nextLine()) as { reused: boolean; port: number };
  expect(started.reused).toBe(false);
  const state = await store.readState();
  expect(state).toMatchObject({ port: started.port, pid: first.child.pid });
  expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
  // Health discovers Chrome under the temporary home, never the user's real profile.
  const health = await send(started.port, {
    headers: { authorization: `Bearer ${state?.token ?? ""}` },
    body: JSON.stringify({ requestId: "h", command: "health", params: {} }),
  });
  const chrome = (health.json as { result: { chrome: { code: string; userDataDir: string } } })
    .result.chrome;
  expect(chrome.code).toBe("missing-file");
  expect(chrome.userDataDir.startsWith(home)).toBe(true);
  // The second process finds the first and exits on its own: it bound no port of its own.
  const second = runNode("apps/service/src/bin.ts", [], home);
  expect(JSON.parse(await second.nextLine())).toEqual({
    reused: true,
    port: started.port,
    pid: first.child.pid,
  });
  expect(await second.exited).toBe(0);
  first.child.kill("SIGTERM");
  expect(await first.exited).toBe(0);
  expect(await store.readState()).toBeUndefined();
  expect(await store.readLock()).toEqual({ kind: "absent" });
  const log = await readFile(join(store.logsFolder, "service.log"), "utf8");
  const events = log
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { event: string }).event);
  expect(events).toEqual(expect.arrayContaining(["service.started", "service.stopped"]));
  expect(log).not.toContain(state?.token ?? "no state");
});

test("SIGTERM during journal writes drains every queued line into a readable journal", async () => {
  const path = join(home, "runs", "run-1", "events.jsonl");
  const count = 20_000;
  const writer = runNode(
    "tests/contract/fixtures/journal-writer.ts",
    [home, path, String(count)],
    home,
  );
  expect(await writer.nextLine()).toBe("queued");
  writer.child.kill("SIGTERM");
  expect(await writer.exited).toBe(0);
  const journal = await readJournal(path);
  expect(journal.gap).toBeUndefined();
  expect(journal.events.length).toBe(count);
  expect(journal.events.every(({ seq }, index) => seq === index + 1)).toBe(true);
});

test("SIGTERM during a replay cancels its remaining steps and stores the interrupted run", async () => {
  const steps = 40;
  const service = runNode("tests/contract/fixtures/replay-service.ts", [home, String(steps)], home);
  const runId = (await service.nextLine()).replace(/^run /, "");
  expect(await service.nextLine()).toBe("replaying");
  service.child.kill("SIGTERM");
  expect(await service.exited).toBe(0);
  const flows = await openFlowStore({ home });
  try {
    const run = await flows.getRun("many-clicks", runId);
    expect(run.summary?.status).toBe("interrupted");
    expect(run.journal.gap).toBeUndefined();
    const finished = run.journal.events.filter(({ type }) => type === "step.finished");
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.length).toBeLessThan(steps);
  } finally {
    flows.close();
  }
}, 20_000);

test("RECNRUN_FORBID_EGRESS=1 makes a connection to a non-loopback host throw", async () => {
  const service = await startFresh(home);
  try {
    expect(() => connect(80, "203.0.113.1")).toThrow(EgressForbiddenError);
    expect(() => connect({ host: "example.com", port: 443 })).toThrow(/forbids connecting/);
    await expect(fetch("http://203.0.113.1/")).rejects.toThrow();
    expect((await command(service, { requestId: "r", command: "health", params: {} })).status).toBe(
      200,
    );
  } finally {
    await service.stop();
  }
});
