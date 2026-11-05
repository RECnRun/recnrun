import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, NAMESPACE, presence, shells } from "./lab.mjs";
import { alive, env, life, scene, script } from "./lifecycle-lab.mjs";

const EX_REFUSED = 65;
const EX_BUSY = 75;
const EX_PAUSED = 73;
const EX_FAILED = 70;

for (const shell of shells) {
  await test(`${shell}: a counter that is not canonical decimal is refused before any effect`, (context) => {
    const { state, request, launches, stateFile } = scene(context);
    mkdirSync(join(state, "profiles"));
    for (const bad of [
      "attempts=08",
      "pid=0",
      "pid=08",
      "startedAt=007",
      "nextAt=1e3",
      "attempts=6",
    ]) {
      writeFileSync(stateFile(), `${bad}\n`);
      const refused = request(shell);
      assert.equal(refused.code, EX_REFUSED, `${bad}: ${refused.err}`);
      assert.match(refused.err, /state file .*: invalid/, bad);
      // The maximum belongs to request; status has none to compare with.
      if (bad !== "attempts=6")
        assert.equal(life(shell, ["status", state], {}).code, EX_REFUSED, bad);
      assert.equal(readFileSync(stateFile(), "utf8"), `${bad}\n`, `${bad} was rewritten`);
    }
    assert.equal(launches(), 0);
  });

  await test(`${shell}: a lock that names zero or a leading-zero number is refused`, (context) => {
    const { state, vars } = scene(context);
    for (const bad of ["0", "08", "-1"]) {
      writeFileSync(join(state, "launcher.lock"), `${bad}\n`);
      const refused = life(shell, ["lock", state], vars());
      assert.equal(refused.code, EX_REFUSED, `${bad}: ${refused.err}`);
      assert.match(refused.err, /does not name a pid/);
    }
  });

  await test(`${shell}: a takeover is serialized by a reclaim lock`, (context) => {
    const { state, vars } = scene(context);
    const lock = join(state, "launcher.lock");
    const reclaim = `${lock}.reclaim`;
    const dead = spawnSync("true").pid;
    writeFileSync(lock, `${dead}\n`);
    writeFileSync(reclaim, `${process.pid}\n`);
    const refused = life(shell, ["lock", state], vars());
    assert.equal(refused.code, EX_BUSY, refused.err);
    assert.match(refused.err, /another launcher is taking over .*launcher\.lock/);
    assert.equal(readFileSync(lock, "utf8").trim(), String(dead), "the stale lock is left alone");
    writeFileSync(reclaim, `${spawnSync("true").pid}\n`);
    assert.equal(life(shell, ["lock", state], vars()).code, 0, "a dead reclaimer is passed over");
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    assert.equal(existsSync(reclaim), false, "the reclaim lock is released");
  });

  await test(`${shell}: of several takeovers of one dead holder exactly one wins and keeps its lock`, async (context) => {
    const { state, vars } = scene(context);
    const lock = join(state, "launcher.lock");
    // The wrapper prints its pid, which is the $PPID the lock names, runs the call, and stays alive
    // for a second so that a winner's lock is never a dead holder's for the others.
    const wrapper = `echo $$; ${shell} "$0" lock "$1"; echo rc=$?; sleep 1`;
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(shell, ["-c", wrapper, script, state], {
          env: env(vars()),
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("close", () => resolve(out.trim().split("\n")));
      });
    for (let round = 0; round < 12; round++) {
      writeFileSync(lock, `${spawnSync("true").pid}\n`);
      const results = await Promise.all(Array.from({ length: 4 }, run));
      const winners = results.filter(([, rc]) => rc === "rc=0");
      assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
      assert.equal(readFileSync(lock, "utf8").trim(), winners[0][0], "the lock names the winner");
      assert.equal(existsSync(`${lock}.reclaim`), false);
      assert.equal(spawnSync("rm", ["-f", lock]).status, 0);
    }
  });

  const siblings = [
    { title: "Profile 1", name: "Profile 1", withPreferences: true, shared: "1" },
    { title: "Profile 12", name: "Profile 12", withPreferences: true, shared: "1" },
    { title: "System Profile", name: "System Profile", withPreferences: true, shared: "0" },
    { title: "Guest Profile", name: "Guest Profile", withPreferences: true, shared: "0" },
    {
      title: "a Profile 1 folder without Preferences",
      name: "Profile 1",
      withPreferences: false,
      shared: "0",
    },
  ];
  for (const { title, name, withPreferences, shared } of siblings) {
    await test(`${shell}: ${title} beside the registered profile makes shared=${shared}`, (context) => {
      const { state, root, vars, request, field } = scene(context);
      mkdirSync(join(root, name));
      if (withPreferences) writeFileSync(join(root, name, "Preferences"), "{}");
      assert.equal(request(shell).code, 0);
      assert.equal(field("shared"), shared);
      const pid = Number(field("pid"));
      const stopped = life(shell, ["stop", state, ALICE], vars({ RECNRUN_LIFECYCLE_STOP_S: "5" }));
      if (shared === "1") {
        assert.equal(stopped.code, EX_FAILED, stopped.err);
        assert.equal(alive(pid), true, "nothing was signalled");
      } else {
        assert.equal(stopped.code, 0, stopped.err);
        assert.equal(alive(pid), false);
      }
    });
  }

  await test(`${shell}: a profile opened into a Chrome already on its root records that Chrome's pid`, (context) => {
    const { root, request, field, spawned } = scene(context, { RECNRUN_STUB_FORWARD: "1" });
    // The root's own Chrome, running before the request; the stub of the request forwards and exits.
    const main = spawn("sh", ["-c", "sleep 30; :", "sh", `--user-data-dir=${root}`], {
      stdio: "ignore",
    });
    spawned.push(main.pid);
    assert.equal(request(shell).code, 0);
    assert.equal(field("shared"), "0");
    assert.equal(Number(field("pid")), main.pid, "not the forwarder's pid");
  });

  await test(`${shell}: a profiles folder that is a symbolic link is refused and nothing is written through it`, (context) => {
    const { home, state, request, launches } = scene(context);
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(state, "profiles"));
    assert.equal(request(shell).code, EX_REFUSED);
    assert.equal(life(shell, ["status", state], {}).code, EX_REFUSED);
    assert.equal(life(shell, ["pause", state, ALICE], {}).code, EX_REFUSED);
    assert.equal(launches(), 0);
    assert.equal(existsSync(join(elsewhere, ALICE)), false);
  });

  await test(`${shell}: a presence under a linked peers folder is ignored`, (context) => {
    const { home, request, launches } = scene(context);
    assert.equal(request(shell).code, 0);
    const peers = join(home, "Downloads/RECnRun/poc", NAMESPACE, "peers");
    const elsewhere = join(home, "elsewhere", ALICE);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "presence.json"), JSON.stringify(presence(ALICE)));
    symlinkSync(join(home, "elsewhere"), peers);
    const silent = request(shell);
    assert.equal(silent.code, EX_PAUSED, silent.err);
    assert.equal(launches(), 1);
  });
}
