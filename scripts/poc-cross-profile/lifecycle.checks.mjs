import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BOB, ALICE, NAMESPACE, shells, until } from "./lab.mjs";
import { alive, env, life, lines, scene, script } from "./lifecycle-lab.mjs";

const EX_REFUSED = 65;
const EX_FAILED = 70;
const EX_PAUSED = 73;
const EX_BUSY = 75;
const EX_NO_ACK = 69;
// A forwarder: the Chrome of the request exits at once, the root's own Chrome keeps the profile.
const forward = { STUB_PROFILE: BOB, RECNRUN_STUB_FORWARD: "1" };

for (const shell of shells) {
  await test(`${shell}: a lock held by a live pid is respected and a dead pid's is taken over`, (context) => {
    const { state, vars } = scene(context);
    const lock = join(state, "launcher.lock");
    assert.equal(life(shell, ["lock", state], vars()).code, 0);
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    const held = life(shell, ["lock", state], vars());
    assert.equal(held.code, EX_BUSY);
    assert.match(held.err, /another launcher holds/);
    assert.equal(life(shell, ["unlock", state], vars()).code, 0);
    assert.equal(existsSync(lock), false);
    const dead = spawnSync("true").pid;
    writeFileSync(lock, `${dead}\n`);
    assert.equal(life(shell, ["lock", state], vars()).code, 0, "a dead holder is taken over");
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    writeFileSync(lock, "1;rm\n");
    assert.equal(life(shell, ["lock", state], vars()).code, EX_REFUSED);
  });

  await test(`${shell}: unlock leaves another holder's lock alone`, (context) => {
    const { state, vars } = scene(context);
    const lock = join(state, "launcher.lock");
    writeFileSync(lock, "1\n");
    assert.equal(life(shell, ["unlock", state], vars()).code, EX_BUSY);
    assert.equal(existsSync(lock), true);
  });

  await test(`${shell}: two concurrent requests of one profile launch once`, async (context) => {
    const { state, record, vars, launches } = scene(context);
    const args = [script, "request", state, record, NAMESPACE, ALICE];
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(shell, args, {
          env: env(vars({ STUB_DELAY: "1", RECNRUN_OPEN_TIMEOUT_S: "5" })),
          stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code));
      });
    const codes = (await Promise.all([run(), run()])).sort();
    assert.deepEqual(codes, [0, EX_BUSY]);
    assert.equal(launches(), 1);
  });

  await test(`${shell}: a request on a fresh open profile relaunches nothing and prints its boot`, (context) => {
    const { request, launches, publish, field } = scene(context);
    const first = request(shell);
    assert.equal(first.code, 0, first.err);
    assert.equal(field("status"), "open");
    publish();
    const second = request(shell);
    assert.equal(second.code, 0, second.err);
    assert.equal(second.out, `boot=${field("boot")}\n`);
    assert.equal(launches(), 1);
  });

  await test(`${shell}: a timeout honors nextAt and doubles the backoff`, async (context) => {
    const { request, launches, field } = scene(context, { STUB_ACK: "", STUB_ALIVE: "" });
    const first = request(shell);
    assert.equal(first.code, EX_NO_ACK, first.err);
    assert.equal(field("status"), "failed");
    assert.equal(field("attempts"), "1");
    const delay1 = Number(field("nextAt")) - Math.floor(Date.now() / 1000);
    assert.ok(delay1 >= 1 && delay1 <= 2, `first backoff ${delay1}`);
    const early = request(shell);
    assert.equal(early.code, EX_FAILED);
    assert.match(early.err, /retry at \d+/);
    assert.equal(launches(), 1);
    await delay(2200);
    assert.equal(request(shell).code, EX_NO_ACK);
    assert.equal(field("attempts"), "2");
    const delay2 = Number(field("nextAt")) - Math.floor(Date.now() / 1000);
    assert.ok(delay2 >= 3 && delay2 <= 4, `second backoff ${delay2}`);
    assert.equal(launches(), 2);
  });

  await test(`${shell}: the attempts stop at the maximum until a reset`, (context) => {
    const { state, request, launches, field } = scene(context, {
      STUB_ACK: "",
      STUB_ALIVE: "",
      RECNRUN_LIFECYCLE_BACKOFF_S: "0",
      RECNRUN_LIFECYCLE_MAX_ATTEMPTS: "2",
    });
    assert.equal(request(shell).code, EX_NO_ACK);
    assert.equal(request(shell).code, EX_NO_ACK);
    const stopped = request(shell);
    assert.equal(stopped.code, EX_FAILED);
    assert.equal(launches(), 2);
    assert.equal(life(shell, ["reset", state, ALICE], {}).code, 0);
    assert.equal(field("attempts"), "0");
    assert.equal(request(shell).code, EX_NO_ACK);
    assert.equal(launches(), 3);
  });

  await test(`${shell}: a paused profile is never launched until resume`, (context) => {
    const { state, request, launches, field } = scene(context);
    assert.equal(life(shell, ["pause", state, ALICE], {}).code, 0);
    assert.equal(field("status"), "paused");
    const refused = request(shell);
    assert.equal(refused.code, EX_PAUSED);
    assert.match(refused.err, /paused/);
    assert.equal(launches(), 0);
    assert.equal(life(shell, ["resume", state, ALICE], {}).code, 0);
    assert.equal(request(shell).code, 0);
    assert.equal(launches(), 1);
  });

  await test(`${shell}: a stopped profile is held until resume, then launches again`, (context) => {
    const { state, request, launches, field } = scene(context);
    assert.equal(request(shell).code, 0);
    const stopped = life(shell, ["stop", state, ALICE], { RECNRUN_LIFECYCLE_STOP_S: "5" });
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(field("status"), "stopped");
    const held = request(shell);
    assert.equal(held.code, EX_PAUSED);
    assert.match(held.err, /stopped: resume it first/);
    assert.equal(launches(), 1, "a stopped profile is never relaunched");
    assert.equal(life(shell, ["resume", state, ALICE], {}).code, 0);
    assert.equal(field("status"), "idle");
    assert.equal(life(shell, ["status", state], {}).out, `${ALICE} idle - 0 0\n`);
    assert.equal(request(shell).code, 0);
    assert.equal(launches(), 2);
  });

  await test(`${shell}: a timed-out open keeps its pid and user data dir, so stop can end it`, (context) => {
    const { state, root, request, field } = scene(context, { STUB_ACK: "" });
    const timedOut = request(shell);
    assert.equal(timedOut.code, EX_NO_ACK, timedOut.err);
    const pid = Number(field("pid"));
    assert.ok(pid > 0 && alive(pid), "the Chrome of the failed open is still running");
    assert.equal(field("userDataDir"), root);
    assert.match(life(shell, ["status", state], {}).out, new RegExp(` failed ${pid} 1 `));
    const stopped = life(shell, ["stop", state, ALICE], { RECNRUN_LIFECYCLE_STOP_S: "5" });
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(alive(pid), false);
    assert.equal(field("status"), "stopped");
  });

  await test(`${shell}: an executor that is alive and silent is paused, not relaunched`, async (context) => {
    const { request, launches, field } = scene(context);
    assert.equal(request(shell).code, 0);
    const pid = Number(field("pid"));
    assert.ok(alive(pid));
    const silent = request(shell);
    assert.equal(silent.code, EX_PAUSED, silent.err);
    assert.equal(field("status"), "paused");
    assert.equal(launches(), 1);
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
  });

  await test(`${shell}: a dead pid with no presence is a crash and relaunches`, async (context) => {
    const { request, launches, field } = scene(context);
    assert.equal(request(shell).code, 0);
    const pid = Number(field("pid"));
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
    const again = request(shell);
    assert.equal(again.code, 0, again.err);
    assert.equal(launches(), 2);
    assert.equal(field("status"), "open");
    assert.notEqual(Number(field("pid")), pid);
  });

  await test(`${shell}: stop sends SIGTERM only to a process that names the user data dir`, async (context) => {
    const { state, request, field, spawned, stateFile } = scene(context);
    assert.equal(request(shell).code, 0);
    const pid = Number(field("pid"));
    const stopped = life(shell, ["stop", state, ALICE], { RECNRUN_LIFECYCLE_STOP_S: "5" });
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(alive(pid), false);
    assert.equal(field("status"), "stopped");
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(bystander.pid);
    const text = readFileSync(stateFile(), "utf8").replace(/^pid=.*$/m, `pid=${bystander.pid}`);
    writeFileSync(stateFile(), text.replace(/^status=.*$/m, "status=open"));
    const refused = life(shell, ["stop", state, ALICE], { RECNRUN_LIFECYCLE_STOP_S: "1" });
    assert.equal(refused.code, EX_REFUSED);
    assert.equal(alive(bystander.pid), true);
  });

  await test(`${shell}: stop kills a process that ignores SIGTERM only with --force`, (context) => {
    const { state, request, field } = scene(context, { STUB_DEAF: "1" });
    assert.equal(request(shell).code, 0);
    const pid = Number(field("pid"));
    const stop = (...flags) =>
      life(shell, ["stop", state, ALICE, ...flags], { RECNRUN_LIFECYCLE_STOP_S: "1" });
    assert.equal(stop().code, EX_FAILED);
    assert.equal(alive(pid), true);
    assert.equal(field("status"), "open");
    assert.equal(stop("--force").code, 0);
    assert.equal(alive(pid), false);
    assert.equal(field("status"), "stopped");
    assert.equal(stop("--hard").code, 64);
  });

  await test(`${shell}: status prints one line per profile`, (context) => {
    const { state, request, field } = scene(context);
    assert.equal(life(shell, ["status", state], {}).out, "");
    assert.equal(request(shell).code, 0);
    const pid = field("pid");
    assert.equal(life(shell, ["status", state], {}).out, `${ALICE} open ${pid} 0 0\n`);
    assert.equal(life(shell, ["pause", state, BOB], {}).code, 0);
    assert.deepEqual(lines(life(shell, ["status", state], {}).out), [
      `${ALICE} open ${pid} 0 0`,
      `${BOB} paused - 0 0`,
    ]);
  });

  await test(`${shell}: a state file with a free value is refused`, (context) => {
    const { state, request, launches, stateFile } = scene(context);
    mkdirSync(join(state, "profiles"));
    for (const bad of [
      "status=sleeping",
      "pid=1;rm",
      "attempts=-1",
      "token=x",
      "extra=1",
      "status=open\nstatus=open",
    ]) {
      writeFileSync(stateFile(), `${bad}\n`);
      assert.equal(request(shell).code, EX_REFUSED, bad);
      assert.equal(life(shell, ["status", state], {}).code, EX_REFUSED, bad);
    }
    assert.equal(launches(), 0);
  });

  await test(`${shell}: a shared-root profile stores the root's main pid, not the forwarder's`, (context) => {
    const { request, launches, field } = scene(context, {}, { shared: true });
    assert.equal(request(shell).code, 0);
    const main = Number(field("pid"));
    assert.ok(alive(main), "the first profile's Chrome is the root's main process");
    const forwarded = request(shell, forward, BOB);
    assert.equal(forwarded.code, 0, forwarded.err);
    assert.equal(launches(), 2);
    assert.equal(field("status", BOB), "open");
    assert.equal(field("shared", BOB), "1");
    assert.equal(Number(field("pid", BOB)), main, "the pid of record is the main process");
    assert.equal(field("shared"), "1");
  });

  await test(`${shell}: stop on a shared-root profile exits 70 and signals nothing`, (context) => {
    const { state, request, field } = scene(context, {}, { shared: true });
    assert.equal(request(shell).code, 0);
    const main = Number(field("pid"));
    assert.equal(request(shell, forward, BOB).code, 0);
    const stopped = life(shell, ["stop", state, BOB], { RECNRUN_LIFECYCLE_STOP_S: "1" });
    assert.equal(stopped.code, EX_FAILED);
    assert.match(stopped.err, /shared root .*: stopping would close every profile of it/);
    assert.equal(alive(main), true);
    assert.equal(field("status", BOB), "open");
    assert.equal(field("pid", BOB), String(main));
  });

  await test(`${shell}: a dead main process of a shared root relaunches each profile`, async (context) => {
    const { request, launches, field } = scene(context, {}, { shared: true });
    assert.equal(request(shell).code, 0);
    assert.equal(request(shell, forward, BOB).code, 0);
    const main = Number(field("pid", BOB));
    process.kill(main, "SIGKILL");
    await until(() => !alive(main));
    assert.equal(request(shell, forward, BOB).code, 0);
    assert.equal(launches(), 3, "a dead main is a crash for the profile that asks");
    assert.equal(field("status", BOB), "open");
  });

  await test(`${shell}: a wrong call exits 64 and a bad mode 65`, (context) => {
    const { state, record, vars } = scene(context);
    assert.equal(life(shell, [], vars()).code, 64);
    assert.equal(life(shell, ["fly"], vars()).code, 64);
    assert.equal(life(shell, ["request", state], vars()).code, 64);
    assert.equal(life(shell, ["lock", join(state, "missing")], vars()).code, 64);
    assert.equal(
      life(shell, ["request", state, record, NAMESPACE, ALICE, "loud"], vars()).code,
      EX_REFUSED,
    );
    assert.equal(life(shell, ["request", state, record, NAMESPACE, BOB], vars()).code, EX_REFUSED);
  });
}
