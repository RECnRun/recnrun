import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ALICE, NAMESPACE, shells } from "./lab.mjs";
import { alive, life, scene, script } from "./lifecycle-lab.mjs";

/** The explicit close and open-clone of lifecycle.sh (POC PLAN.md P7.5), under the profile lock. */
const close = (shell, s, extra) =>
  life(shell, ["close", s.state, s.record, NAMESPACE, ALICE], s.vars(extra));
const openClone = (shell, s, mode, extra) =>
  life(shell, ["open-clone", s.state, s.record, NAMESPACE, ALICE, mode], s.vars(extra));
const edit = (s, pattern, text) => {
  const file = s.stateFile();
  writeFileSync(file, readFileSync(file, "utf8").replace(pattern, text));
};

const chromePath = (s) =>
  join(s.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

for (const shell of shells) {
  await test(`${shell}: close stops the Chrome with SIGINT and holds the clone closed`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell, {}, ALICE, "headless").code, 0);
    const pid = Number(s.field("pid"));
    const closed = close(shell, s);
    assert.equal(closed.code, 0, closed.err);
    assert.deepEqual(s.signals(), ["int"]);
    assert.equal(alive(pid), false);
    assert.equal(s.field("status"), "stopped");
    assert.equal(s.field("mode"), "headless");
    assert.equal(s.request(shell).code, 73);
  });

  await test(`${shell}: close of a clone with no state holds it closed`, (context) => {
    const s = scene(context);
    assert.equal(close(shell, s).code, 0);
    assert.equal(s.field("status"), "stopped");
    assert.equal(s.request(shell).code, 73);
  });

  await test(`${shell}: a Chrome that outlives the wait keeps the stop intent and the pid, and fails`, (context) => {
    const s = scene(context, { STUB_DEAF: "1" });
    assert.equal(s.request(shell).code, 0);
    const pid = s.field("pid");
    const closed = close(shell, s, { RECNRUN_LIFECYCLE_STOP_S: "1" });
    assert.equal(closed.code, 74, closed.err);
    assert.match(closed.err, /still runs after 1 s/);
    assert.equal(s.field("status"), "stopped");
    assert.equal(s.field("pid"), pid);
    assert.deepEqual(s.signals(), []);
  });

  await test(`${shell}: close refuses a state that names another root and signals nothing`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    edit(s, /^userDataDir=.*$/m, `userDataDir=${s.home}`);
    const closed = close(shell, s);
    assert.equal(closed.code, 65, closed.err);
    assert.match(closed.err, /names .* not the registered/);
    assert.deepEqual(s.signals(), []);
    assert.equal(s.field("status"), "open");
  });

  await test(`${shell}: close refuses a shared root before any signal, state or no state`, (context) => {
    const s = scene(context, {}, { shared: true });
    assert.equal(s.request(shell).code, 0);
    assert.equal(close(shell, s).code, 70);
    assert.deepEqual(s.signals(), []);
    assert.equal(s.field("status"), "open");
  });

  await test(`${shell}: close refuses an open attempt under way and stops an abandoned one`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    const now = Math.floor(Date.now() / 1000);
    edit(s, /^status=.*$/m, "status=opening");
    edit(s, /^startedAt=.*$/m, `startedAt=${now}`);
    const refused = close(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "60" });
    assert.equal(refused.code, 75, refused.err);
    assert.deepEqual(s.signals(), []);
    edit(s, /^startedAt=.*$/m, `startedAt=${now - 120}`);
    assert.equal(close(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "60" }).code, 0);
    assert.equal(s.field("status"), "stopped");
  });

  await test(`${shell}: open-clone launches a stopped clone in the mode asked`, (context) => {
    const s = scene(context);
    assert.equal(close(shell, s).code, 0);
    const opened = openClone(shell, s, "headless");
    assert.equal(opened.code, 0, opened.err);
    assert.equal(s.launches(), 1);
    assert.equal(s.field("status"), "open");
    assert.equal(s.field("mode"), "headless");
  });

  await test(`${shell}: open-clone adopts a running clone of the same mode and resumes it`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell, {}, ALICE, "headless").code, 0);
    edit(s, /^status=.*$/m, "status=stopped");
    const before = s.launches();
    const opened = openClone(shell, s, "headless");
    assert.equal(opened.code, 0, opened.err);
    assert.equal(s.launches(), before);
    assert.equal(s.field("status"), "open");
    assert.equal(s.field("pid") === "", false);
  });

  await test(`${shell}: open-clone refuses a running clone of the other mode`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell, {}, ALICE, "headless").code, 0);
    const before = s.launches();
    const refused = openClone(shell, s, "headed");
    assert.equal(refused.code, 65, refused.err);
    assert.match(refused.err, /already runs in headless/);
    assert.equal(s.launches(), before);
    assert.deepEqual(s.signals(), []);
  });

  await test(`${shell}: open-clone launches again when the state says open but no Chrome runs`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    process.kill(Number(s.field("pid")), "SIGKILL");
    s.publish();
    const opened = openClone(shell, s, "headed");
    assert.equal(opened.code, 0, opened.err);
    assert.equal(s.launches(), 2);
  });

  await test(`${shell}: open-clone refuses a state that names another root`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    edit(s, /^userDataDir=.*$/m, `userDataDir=${s.home}`);
    const refused = openClone(shell, s, "headed");
    assert.equal(refused.code, 65, refused.err);
  });

  await test(`${shell}: close refuses a frozen base even when it carries a clone marker`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    const pid = Number(s.field("pid"));
    writeFileSync(join(s.root, ".recnrun-base"), "base\n");
    const refused = close(shell, s);
    assert.equal(refused.code, 65, refused.err);
    assert.match(refused.err, /frozen base/);
    assert.deepEqual(s.signals(), []);
    assert.equal(alive(pid), true);
  });

  await test(`${shell}: close and open-clone refuse a block that is not a worker`, (context) => {
    const s = scene(context);
    edit({ stateFile: () => s.record }, /role=worker/, "role=template");
    assert.equal(close(shell, s).code, 65);
    const refused = openClone(shell, s, "headed");
    assert.equal(refused.code, 65, refused.err);
    assert.match(refused.err, /not a worker/);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: close and open-clone refuse an id that more than one block names`, (context) => {
    const s = scene(context);
    appendFileSync(
      s.record,
      `\nuserDataDir=${s.home}\nprofileDirectory=Default\nprofileId=${ALICE}\nnamespace=${NAMESPACE}\nrole=template\n`,
    );
    const refused = close(shell, s);
    assert.equal(refused.code, 65, refused.err);
    assert.match(refused.err, /more than one block|in 2 blocks/);
    assert.equal(openClone(shell, s, "headed").code, 65);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: close and open-clone refuse a root other than the one the caller checked`, (context) => {
    const s = scene(context);
    const refused = close(shell, s, { RECNRUN_CONTROL_ROOT: `${s.home}/elsewhere` });
    assert.equal(refused.code, 65, refused.err);
    assert.match(refused.err, /not the root/);
    assert.equal(close(shell, s, { RECNRUN_CONTROL_ROOT: s.root }).code, 0);
  });

  await test(`${shell}: close signals the main process even when the state names a renderer`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    const main = Number(s.field("pid"));
    const renderer = spawn(chromePath(s), [`--user-data-dir=${s.root}`, "--type=renderer"], {
      stdio: "ignore",
      env: s.vars({ STUB_ACK: "", STUB_ALIVE: "30" }),
    });
    s.spawned.push(renderer.pid);
    spawnSync("sleep", ["0.3"]);
    edit(s, /^pid=.*$/m, `pid=${renderer.pid}`);
    const closed = close(shell, s);
    assert.equal(closed.code, 0, closed.err);
    assert.equal(alive(main), false);
    assert.equal(alive(renderer.pid), true);
  });

  await test(`${shell}: an opener resumed after a close does not start Chrome`, async (context) => {
    const s = scene(context);
    assert.equal(close(shell, s).code, 0);
    const lock = join(s.state, "profiles", `${ALICE}.lock`);
    writeFileSync(join(s.home, "hold"), "");
    const opener = spawn(
      shell,
      [script, "open-clone", s.state, s.record, NAMESPACE, ALICE, "headed"],
      {
        stdio: "ignore",
        env: s.vars({ STUB_HOLD_LOCK: lock }),
      },
    );
    const ended = new Promise((resolve) => opener.on("close", resolve));
    for (let waited = 0; !existsSync(join(s.home, "held")) && waited < 100; waited++)
      await sleep(100);
    assert.equal(existsSync(join(s.home, "held")), true, "the opener never reached its launch");
    await sleep(2200);
    const closed = close(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "1" });
    assert.equal(closed.code, 0, closed.err);
    rmSync(join(s.home, "hold"));
    assert.notEqual(await ended, 0);
    assert.equal(s.launches(), 0);
    assert.equal(s.field("status"), "stopped");
    assert.equal(s.field("pid"), "");
  });

  await test(`${shell}: an opener does not start Chrome when the record changed after the check`, async (context) => {
    const s = scene(context);
    assert.equal(close(shell, s).code, 0);
    const lock = join(s.state, "profiles", `${ALICE}.lock`);
    writeFileSync(join(s.home, "hold"), "");
    const opener = spawn(
      shell,
      [script, "open-clone", s.state, s.record, NAMESPACE, ALICE, "headed"],
      { stdio: "ignore", env: s.vars({ STUB_HOLD_LOCK: lock }) },
    );
    const ended = new Promise((resolve) => opener.on("close", resolve));
    for (let waited = 0; !existsSync(join(s.home, "held")) && waited < 100; waited++)
      await sleep(100);
    assert.equal(existsSync(join(s.home, "held")), true, "the opener never reached its launch");
    writeFileSync(s.record, readFileSync(s.record, "utf8").replace("role=worker", "role=master"));
    rmSync(join(s.home, "hold"));
    assert.notEqual(await ended, 0);
    assert.equal(s.launches(), 0);
  });
}
