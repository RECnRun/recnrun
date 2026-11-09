import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";
import { EX_LOCKED, EX_USAGE, launcherScene, waitFor } from "./launcher-lab.mjs";

const release = Object.fromEntries(
  readFileSync(new URL("./RELEASE", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=")),
);
const seqOf = (s) => Number(s.heartbeat().seq ?? -1);

for (const shell of shells) {
  await test(`${shell}: the launcher publishes a heartbeat and holds the lock`, async (context) => {
    const s = launcherScene(context, shell);
    const run = s.start();
    await waitFor(() => seqOf(s) >= 2);
    const text = readFileSync(join(s.ws, "launcher/heartbeat"), "utf8");
    assert.equal(text.split("\n")[0], "recnrun-lab-heartbeat v1");
    const beat = s.heartbeat();
    assert.match(beat.session, /^[0-9a-f]{16}$/);
    assert.match(beat.at, /^\d+$/);
    assert.deepEqual([beat.state, beat.paired], ["idle", "none"]);
    assert.deepEqual([beat.launcher, beat.extension], [release.version, release.extensionVersion]);
    const second = s.start();
    assert.equal(await second.exited, EX_LOCKED, second.err);
    assert.match(second.err, /another launcher holds/);
    process.kill(run.pid, "SIGINT");
    assert.equal(await run.exited, 130, run.err);
    assert.ok(!existsSync(join(s.ws, "launcher/heartbeat")), "the heartbeat is removed");
    assert.ok(!existsSync(join(s.state, "launcher.lock")), "the lock is released");
  });

  await test(`${shell}: SIGTERM stops the launcher with 143`, async (context) => {
    const s = launcherScene(context, shell);
    const run = s.start(["--allow-any"]);
    await waitFor(() => seqOf(s) >= 1);
    process.kill(run.pid, "SIGTERM");
    assert.equal(await run.exited, 143, run.err);
    assert.ok(!existsSync(join(s.ws, "launcher/heartbeat")));
  });

  await test(`${shell}: a killed launcher's heartbeat freezes and the next start takes over`, async (context) => {
    const s = launcherScene(context, shell);
    const run = s.start();
    await waitFor(() => seqOf(s) >= 2);
    const session = s.heartbeat().session;
    process.kill(run.pid, "SIGKILL");
    await run.exited;
    await delay(600);
    const frozen = seqOf(s);
    await delay(800);
    assert.equal(seqOf(s), frozen, "no writer outlives the launcher");
    const next = s.start();
    await waitFor(() => s.heartbeat().session !== session && seqOf(s) >= 1);
    process.kill(next.pid, "SIGINT");
    assert.equal(await next.exited, 130, next.err);
  });

  await test(`${shell}: a wrong call exits 64 before anything starts`, async (context) => {
    const s = launcherScene(context, shell);
    for (const args of [
      [],
      ["--allow", "ftp://example.com"],
      ["--allow", "https://a/b"],
      ["--bogus"],
      ["--pair", "abc"],
    ]) {
      const run = s.start(args);
      assert.equal(await run.exited, EX_USAGE, `${args.join(" ")}: ${run.err}`);
    }
    assert.ok(!existsSync(join(s.ws, "launcher/heartbeat")));
  });
}
