import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ALICE, BOB, NAMESPACE, shells, until } from "./lab.mjs";
import { alive, env, lines, life, scene, script as lifecycleScript } from "./lifecycle-lab.mjs";
import { commandScene, launcher, launcherScript, registerDownloads } from "./commands-lab.mjs";

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

  await test(`${shell}: start --once leaves a stopped profile alone until it is resumed`, (context) => {
    const scene = commandScene(context);
    assert.equal(life(shell, ["pause", scene.state, BOB], {}).code, 0);
    assert.equal(start(shell, scene, "--once").code, 0);
    const stopped = life(
      shell,
      ["stop", scene.state, ALICE],
      scene.vars({ RECNRUN_LIFECYCLE_STOP_S: "5" }),
    );
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(start(shell, scene, "--once").code, 0);
    assert.equal(scene.argv().length, 1, "the stopped profile was relaunched");
    assert.equal(scene.field("status"), "stopped");
    assert.equal(life(shell, ["resume", scene.state, ALICE], {}).code, 0);
    assert.equal(start(shell, scene, "--once").code, 0);
    assert.equal(scene.argv().length, 2);
    assert.equal(scene.field("status"), "open");
  });

  await test(`${shell}: stop --all also ends the profiles that run, a timed-out open included`, (context) => {
    const scene = commandScene(context);
    assert.equal(start(shell, scene, "--once").code, 0);
    const pid = Number(scene.field("pid"));
    const lost = Number(scene.field("pid", BOB));
    assert.equal(scene.field("status", BOB), "failed", "BOB never acks");
    assert.ok(alive(pid) && alive(lost));
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
    assert.equal(alive(lost), false, "the Chrome of the timed-out open was signalled");
    assert.equal(scene.field("status"), "stopped");
    assert.equal(scene.field("status", BOB), "stopped");
  });

  await test(`${shell}: stop --all skips the profiles of a shared root and signals nothing`, (context) => {
    const shared = scene(context, {}, { shared: true });
    assert.equal(shared.request(shell).code, 0);
    const forward = { STUB_PROFILE: BOB, RECNRUN_STUB_FORWARD: "1" };
    assert.equal(shared.request(shell, forward, BOB).code, 0);
    const main = Number(shared.field("pid", BOB));
    const vars = shared.vars({ RECNRUN_LIFECYCLE_STOP_S: "1" });
    const all = launcher(shell, ["stop", shared.state, "--all"], vars);
    assert.equal(all.code, 0, all.err);
    assert.match(all.err, new RegExp(`${BOB}: shared root .*: stopping would close every profile`));
    assert.equal(alive(main), true);
    assert.equal(shared.field("status", BOB), "open");
    assert.equal(shared.field("status"), "open");
  });

  // A dot keeps the assignment of its own command line, so a sourced library must restore the switch.
  for (const script of [lifecycleScript, launcherScript]) {
    await test(`${shell}: sourcing ${basename(script)} does not leave the library switch behind`, (context) => {
      const scene = commandScene(context);
      assert.equal(life(shell, ["pause", scene.state, ALICE], {}).code, 0);
      const probe =
        'set -- status "$1"; . "$0"; printf "lib=[%s]\\n" "${RECNRUN_DISCOVERY_LIB:-}"; ';
      const child = `${shell} "$0" status "$1"`;
      const result = spawnSync(shell, ["-c", `${probe}${child}`, script, scene.state], {
        encoding: "utf8",
        env: env(scene.vars()),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^lib=\[\]$/m, result.stdout);
      assert.match(result.stdout, new RegExp(`^${ALICE} paused - 0 0$`, "m"), result.stdout);
    });
  }
}

const registryOf = (downloads) => join(downloads, "RECnRun/poc", NAMESPACE, "registry.json");
const catalogRuns = (stderr) =>
  lines(stderr).filter((line) => line.startsWith("recnrun-launcher.sh: catalog.sh for "));

for (const shell of shells) {
  await test(`${shell}: start --once writes the registry and a second pass rewrites it`, (context) => {
    const scene = commandScene(context);
    const downloads = join(scene.home, "Downloads");
    registerDownloads(scene, { [ALICE]: downloads });
    scene.publish();
    const first = start(shell, scene, "--once");
    assert.equal(first.code, 0, first.err);
    const registry = JSON.parse(readFileSync(registryOf(downloads), "utf8"));
    assert.equal(registry.version, 1);
    assert.equal(registry.namespace, NAMESPACE);
    assert.ok(Object.keys(registry.peers).includes(ALICE), JSON.stringify(registry));
    assert.equal(catalogRuns(first.err).length, 1, first.err);
    writeFileSync(registryOf(downloads), JSON.stringify({ ...registry, writtenAt: 1 }));
    const second = start(shell, scene, "--once");
    assert.equal(second.code, 0, second.err);
    assert.ok(JSON.parse(readFileSync(registryOf(downloads), "utf8")).writtenAt > 1);
  });

  await test(`${shell}: start --once runs the catalog once per Downloads root, also when every profile is open`, (context) => {
    const scene = commandScene(context);
    const downloads = join(scene.home, "Downloads");
    const other = join(scene.home, "Downloads-other");
    registerDownloads(scene, { [ALICE]: downloads, [BOB]: downloads });
    assert.equal(start(shell, scene, "--once").code, 0);
    const again = start(shell, scene, "--once");
    assert.equal(catalogRuns(again.err).length, 1, "two profiles on one root: one catalog run");
    mkdirSync(join(other, "RECnRun/poc", NAMESPACE), { recursive: true });
    // The first runs wrote root=r1 into the block; a profile moved to another root is a new block.
    const blocks = readFileSync(scene.record, "utf8").split("\n\n");
    const moved = blocks.map((it) =>
      it.includes(`profileId=${BOB}`)
        ? it.replace(/^root=.*\n?/m, "").replace(downloads, other)
        : it,
    );
    writeFileSync(scene.record, moved.join("\n\n"));
    const split = start(shell, scene, "--once");
    assert.equal(catalogRuns(split.err).length, 2, split.err);
    assert.equal(existsSync(registryOf(other)), true, split.err);
  });

  await test(`${shell}: a catalog that cannot write is logged, not fatal`, (context) => {
    const scene = commandScene(context);
    const missing = join(scene.home, "Downloads-missing");
    const text = readFileSync(scene.record, "utf8");
    writeFileSync(
      scene.record,
      text.replace(`profileId=${BOB}\n`, `profileId=${BOB}\ndownloadsRoot=${missing}\n`),
    );
    const result = start(shell, scene, "--once");
    assert.equal(result.code, 0, result.err);
    assert.match(result.err, /catalog\.sh for .*: exit 73, not an error/);
  });
}
