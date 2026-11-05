import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, BOB, NAMESPACE, shells, until } from "./lab.mjs";
import { alive, lines, life } from "./lifecycle-lab.mjs";
import { commandScene, launcher, launcherScript } from "./commands-lab.mjs";

const EX_USAGE = 64;
const EX_REFUSED = 65;
const EX_BUSY = 75;

const start = (shell, scene, ...flags) =>
  launcher(shell, ["start", scene.state, scene.record, NAMESPACE, ...flags], scene.vars());
const status = (shell, scene) => launcher(shell, ["status", scene.state], scene.vars());

/** A long-running launcher in its own process; the scene's cleanup kills it with the home. */
function daemon(shell, scene) {
  const child = spawn(shell, [launcherScript, "start", scene.state, scene.record, NAMESPACE], {
    env: { PATH: process.env.PATH, ...scene.vars({ RECNRUN_LAUNCHER_INTERVAL_S: "1" }) },
    stdio: "ignore",
  });
  scene.spawned.push(child.pid);
  return child;
}

for (const shell of shells) {
  await test(`${shell}: start --once requests each profile of the namespace and no other`, (context) => {
    const scene = commandScene(context);
    const result = start(shell, scene, "--once");
    assert.equal(result.code, 0, result.err);
    const argv = scene.argv();
    assert.equal(argv.length, 2, argv.join("\n"));
    assert.ok(argv.some((line) => line.includes(`--user-data-dir=${scene.root} `)));
    assert.ok(argv.some((line) => line.includes(`--user-data-dir=${scene.roots[BOB]} `)));
    assert.ok(argv.every((line) => !line.includes(scene.roots[Object.keys(scene.roots)[1]])));
    assert.equal(scene.field("status"), "open");
    assert.equal(existsSync(join(scene.state, "launcher.lock")), false, "the lock is released");
    assert.equal(existsSync(join(scene.state, "launcher.pid")), false);
  });

  await test(`${shell}: start --once skips a paused profile`, (context) => {
    const scene = commandScene(context);
    assert.equal(life(shell, ["pause", scene.state, BOB], {}).code, 0);
    const result = start(shell, scene, "--once");
    assert.equal(result.code, 0, result.err);
    const argv = scene.argv();
    assert.equal(argv.length, 1, argv.join("\n"));
    assert.ok(argv[0].includes(`--user-data-dir=${scene.root} `));
    assert.equal(scene.field("status", BOB), "paused");
  });

  await test(`${shell}: start refuses a free argument, a bad value, and a held lock`, (context) => {
    const scene = commandScene(context);
    const { state, record } = scene;
    const run = (...args) => launcher(shell, args, scene.vars());
    assert.equal(run("start").code, EX_USAGE);
    assert.equal(run("start", state, record, NAMESPACE, "--twice").code, EX_USAGE);
    assert.equal(run("start", state, record, NAMESPACE, "--once", "extra").code, EX_USAGE);
    assert.equal(run("start", join(state, "missing"), record, NAMESPACE, "--once").code, EX_USAGE);
    assert.equal(run("start", state, "relative.record", NAMESPACE, "--once").code, EX_REFUSED);
    assert.equal(run("start", state, join(state, "nope"), NAMESPACE, "--once").code, EX_REFUSED);
    assert.equal(run("start", state, record, "Lab_1", "--once").code, EX_REFUSED);
    assert.equal(run("fly").code, EX_USAGE);
    assert.equal(run().code, EX_USAGE);
    assert.equal(run("status").code, EX_USAGE);
    assert.equal(run("stop", state, "--hard").code, EX_USAGE);
    assert.equal(run("start", state, record, NAMESPACE, "--once").code, 0);
    writeFileSync(join(state, "launcher.lock"), `${process.pid}\n`);
    const busy = run("start", state, record, NAMESPACE, "--once");
    assert.equal(busy.code, EX_BUSY);
    assert.match(busy.err, /another launcher holds/);
    assert.equal(scene.argv().length, 2, "the held lock stopped the pass");
  });

  await test(`${shell}: status tells a running launcher from a stopped one, then lists the profiles`, async (context) => {
    const scene = commandScene(context);
    assert.equal(status(shell, scene).out, "launcher stopped\n");
    const child = daemon(shell, scene);
    await until(() => existsSync(join(scene.state, "launcher.pid")));
    await until(() => existsSync(scene.stateFile()));
    const running = lines(status(shell, scene).out);
    assert.equal(running[0], `launcher running pid=${child.pid}`);
    assert.ok(
      running.some((line) => line.startsWith(`${ALICE} `)),
      running.join("\n"),
    );
    const stopped = launcher(shell, ["stop", scene.state], scene.vars());
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(alive(child.pid), false);
    assert.equal(status(shell, scene).out.split("\n")[0], "launcher stopped");
    assert.equal(
      existsSync(join(scene.state, "launcher.lock")),
      false,
      "SIGTERM released the lock",
    );
  });

  await test(`${shell}: stop signals only a pid whose command line names the launcher`, (context) => {
    const scene = commandScene(context);
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    scene.spawned.push(bystander.pid);
    writeFileSync(join(scene.state, "launcher.pid"), `${bystander.pid}\n`);
    assert.equal(status(shell, scene).out.split("\n")[0], "launcher stopped");
    const stopped = launcher(shell, ["stop", scene.state], scene.vars());
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(alive(bystander.pid), true);
    writeFileSync(join(scene.state, "launcher.pid"), "1;rm\n");
    assert.equal(status(shell, scene).out.split("\n")[0], "launcher stopped");
  });

  await test(`${shell}: stop --all also ends the profiles that run`, (context) => {
    const scene = commandScene(context);
    assert.equal(life(shell, ["pause", scene.state, BOB], {}).code, 0);
    assert.equal(start(shell, scene, "--once").code, 0);
    const pid = Number(scene.field("pid"));
    assert.ok(alive(pid));
    const stop = (...flags) =>
      launcher(
        shell,
        ["stop", scene.state, ...flags],
        scene.vars({ RECNRUN_LIFECYCLE_STOP_S: "5" }),
      );
    assert.equal(stop().code, 0);
    assert.equal(alive(pid), true, "plain stop leaves the profiles");
    const all = stop("--all");
    assert.equal(all.code, 0, all.err);
    assert.equal(alive(pid), false);
    assert.equal(scene.field("status"), "stopped");
  });
}
