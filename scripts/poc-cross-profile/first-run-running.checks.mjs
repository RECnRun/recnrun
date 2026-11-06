import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";

const CHROME = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The person's own Chrome: running before first-run, started without --user-data-dir. */
async function personalChrome(scene) {
  const env = {
    PATH: process.env.PATH,
    HOME: scene.home,
    STUB_LOG: join(scene.home, "own.txt"),
    STUB_ALIVE: "60",
  };
  const child = spawn(join(scene.home, CHROME), [], { env, stdio: "ignore" });
  scene.spawned.push(child.pid);
  for (let tries = 0; tries < 50; tries++) {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
    if (ps.stdout.includes("Google Chrome") && !ps.stdout.includes("perl")) return child.pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the personal Chrome did not start");
}

for (const shell of shells) {
  await test(`${shell}: first-run counts a profile open when its ack came from the Chrome already running`, async (context) => {
    const scene = firstRunScene(context);
    scene.unpublish();
    const main = await personalChrome(scene);
    const vars = scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2", RECNRUN_STUB_FORWARD: "1" });
    const result = firstRun(shell, [scene.state, scene.record, "lab"], vars);
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
    assert.equal(scene.launches(), 1, "the acked bind was the open; no second launch");
    assert.equal(scene.field("status"), "open");
    assert.equal(
      Number(scene.field("pid")),
      main,
      "the running Chrome's pid, found without a flag",
    );
  });
}
