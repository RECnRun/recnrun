import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/* The temporary roots, presences, and runs of catalog.sh that its checks share. */

export const script = fileURLToPath(new URL("./catalog.sh", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
// RECNRUN_UPDATE_FIXTURES=1 rewrites the samples the extension's unit tests parse.
const updateFixtures = process.env.RECNRUN_UPDATE_FIXTURES === "1";
export const BOOT = "44444444-4444-4444-8444-444444444444";
export const NAMESPACE = "lab-1";
export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333";
// Far enough ahead that no run of these checks sees it expire.
const LATER = 4_000_000_000_000;
export const EX_USAGE = 64;
export const EX_DATAERR = 65;
export const EX_TEMPFAIL = 75;

const dash = spawnSync("sh", ["-c", "command -v dash"], { encoding: "utf8" }).stdout.trim();
export const shells = ["sh", ...(dash ? [dash] : [])];

export const PEER_BOOT = "55555555-5555-4555-8555-555555555555";

/** A registration, in the key order of RegistrationSchema, as the extension publishes it. */
export function presence(profileId, overrides = {}) {
  return {
    profileId,
    displayName: "Desk",
    fingerprint: "AB:CD:EF",
    createdAt: 1_800_000_000_000,
    expiresAt: LATER,
    namespace: NAMESPACE,
    boot: PEER_BOOT,
    ...overrides,
  };
}

/** A temporary home with two Downloads roots, an output folder, and a record file. */
export function lab(context) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-catalog-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const rootA = join(home, "Downloads A");
  const rootB = join(home, "Downloads_B");
  const out = join(home, "out");
  for (const folder of [rootA, rootB, out]) mkdirSync(folder, { recursive: true });
  return { home, rootA, rootB, out, record: join(home, "launcher.record") };
}

/** Publishes a file as the extension would, below <root>/RECnRun/poc/<namespace>/peers/. */
export function publish(root, folder, text, name = "presence.json") {
  const directory = join(root, "RECnRun/poc", NAMESPACE, "peers", folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), text);
  return directory;
}

export const announce = (root, value) => publish(root, value.profileId, JSON.stringify(value));

export function run(shell, args, env = { RECNRUN_LAUNCHER_BOOT: BOOT }) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: result.status, stderr: result.stderr };
}

/** Starts a run in its own process group, so a signal reaches the shell and its children. */
export function start(shell, args) {
  const child = spawn(shell, [script, ...args], {
    detached: true,
    env: { PATH: process.env.PATH, RECNRUN_LAUNCHER_BOOT: BOOT },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited };
}

export async function until(condition) {
  for (let tries = 0; tries < 500; tries += 1) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error("timed out");
}

export const readRegistry = (out) => JSON.parse(readFileSync(join(out, "registry.json"), "utf8"));

/** The registry with its clock fields fixed, after checking they are the run's time. */
export function normalized(registry, before) {
  assert.ok(registry.writtenAt >= Math.floor(before / 1000) * 1000);
  assert.ok(registry.writtenAt <= Date.now());
  const peers = Object.fromEntries(
    Object.entries(registry.peers).map(([id, peer]) => {
      assert.equal(peer.lastSeenAt, registry.writtenAt);
      return [id, { ...peer, lastSeenAt: 1_800_000_000_500 }];
    }),
  );
  return { ...registry, writtenAt: 1_800_000_000_500, peers };
}

export function sample(name, actual) {
  const path = join(fixtures, name);
  if (updateFixtures) writeFileSync(path, actual);
  assert.equal(
    actual,
    readFileSync(path, "utf8"),
    `${name} is stale; rerun with RECNRUN_UPDATE_FIXTURES=1`,
  );
}

export const peerOf = (profileId, root) => ({
  profileId,
  displayName: "Desk",
  fingerprint: "AB:CD:EF",
  root,
  lastSeenAt: 1_800_000_000_500,
  expiresAt: LATER,
  boot: PEER_BOOT,
});
