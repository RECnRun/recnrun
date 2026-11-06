import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const EX_FAILED = 70;
const LABEL = "com.recnrun.launcher";

// Every check runs on the fixture HOME with a recording launchctl first on PATH: nothing reaches the real one.
function installScene(context, ...options) {
  const scene = firstRunScene(context, ...options);
  const bin = join(scene.home, "stubs");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "launchctl");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf 'launchctl %s\\n' "$*" >>"${scene.home}/calls.txt"\nexit "\${STUB_RC:-0}"\n`,
  );
  chmodSync(stub, 0o755);
  const calls = () => {
    const file = join(scene.home, "calls.txt");
    return existsSync(file) ? lines(readFileSync(file, "utf8")) : [];
  };
  const vars = (extra) =>
    scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2", PATH: `${bin}:${scene.vars().PATH}`, ...extra });
  return {
    ...scene,
    vars,
    calls,
    plist: join(scene.home, "Library/LaunchAgents", `${LABEL}.plist`),
  };
}
const args = (scene, ...flags) => [...flags, scene.state, scene.record, "lab"];

for (const shell of shells) {
  await test(`${shell}: first-run --autostart turns autostart on after every profile is open`, (context) => {
    const scene = installScene(context);
    const result = firstRun(shell, args(scene, "--autostart"), scene.vars());
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
    assert.equal(lines(result.out).at(-1), "autostart on");
    const text = readFileSync(scene.plist, "utf8");
    for (const value of [scene.state, scene.record, "lab"])
      assert.ok(text.includes(`<string>${value}</string>`), `${value} in the plist`);
    assert.equal(scene.calls().filter((call) => call.startsWith("launchctl bootstrap")).length, 1);
    assert.doesNotMatch(result.out, /^next:/m);
  });

  await test(`${shell}: first-run --autostart with no other argument uses the defaults under HOME`, (context) => {
    const scene = installScene(context);
    const result = firstRun(shell, ["--autostart"], scene.vars());
    assert.equal(result.code, 0, result.err);
    assert.ok(
      readFileSync(scene.plist, "utf8").includes(
        `<string>${scene.home}/.recnrun/launcher</string>`,
      ),
    );
  });

  await test(`${shell}: first-run without the flag leaves autostart alone and names it`, (context) => {
    const scene = installScene(context);
    const result = firstRun(shell, args(scene), scene.vars());
    assert.equal(result.code, 0, result.err);
    assert.equal(existsSync(scene.plist), false);
    assert.deepEqual(scene.calls(), []);
    assert.match(result.out, /^next: sh recnrun-launcher autostart on /m);
  });

  await test(`${shell}: first-run --autostart does not turn it on when a profile does not ack`, (context) => {
    const scene = installScene(context, "lab", { shared: true });
    scene.ack({ Default: ALICE });
    const result = firstRun(shell, args(scene, "--autostart"), scene.vars());
    assert.equal(result.code, EX_FAILED);
    assert.equal(existsSync(scene.plist), false);
    assert.deepEqual(scene.calls(), []);
  });

  await test(`${shell}: first-run --autostart does not turn it on when the Default is not the master`, (context) => {
    const scene = installScene(context);
    const result = firstRun(
      shell,
      args(scene, "--autostart"),
      scene.vars({ STUB_MASTER_FAIL: "1" }),
    );
    assert.equal(result.code, EX_FAILED);
    assert.match(result.err, /did not become the master/);
    assert.equal(existsSync(scene.plist), false);
    assert.deepEqual(scene.calls(), []);
  });

  await test(`${shell}: first-run --autostart exits 70 when autostart fails, the profiles stay open`, (context) => {
    const scene = installScene(context);
    const result = firstRun(shell, args(scene, "--autostart"), scene.vars({ STUB_RC: "1" }));
    assert.equal(result.code, EX_FAILED);
    assert.match(result.err, /autostart on failed/);
    assert.equal(scene.field("status"), "open");
  });

  await test(`${shell}: the entry's install command is first-run --autostart`, (context) => {
    const scene = installScene(context);
    const folder = join(scene.home, "package");
    mkdirSync(folder);
    for (const name of readdirSync(here).filter(
      (it) => it.endsWith(".sh") || it === "extension-id",
    ))
      cpSync(join(here, name), join(folder, name));
    cpSync(join(here, "package/recnrun-launcher"), join(folder, "recnrun-launcher"));
    const result = firstRun(shell, ["install", ...args(scene)], scene.vars(), {
      script: join(folder, "recnrun-launcher"),
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out).at(-1), "autostart on");
    assert.ok(existsSync(scene.plist));
  });
}
