import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, BOB, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";

const EX_USAGE = 64;
const EX_REFUSED = 65;
const EX_NONE = 66;
const EX_FAILED = 70;

/** The environment of a first run: the scene's, with a one-second open timeout. */
const vars = (scene, extra = {}) => scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2", ...extra });
const explicit = (scene, namespace = "lab") => [scene.state, scene.record, namespace];
const blocks = (record) => readFileSync(record, "utf8").split("\n\n").filter(Boolean);

for (const shell of shells) {
  await test(`${shell}: first-run registers the profile with a presence, opens it, and names autostart`, (context) => {
    const scene = firstRunScene(context);
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
    assert.equal(
      lines(result.out).at(-1),
      `next: sh recnrun-launcher autostart on ${scene.state} ${scene.record} lab`,
    );
    assert.deepEqual(blocks(scene.record), [
      [
        `userDataDir=${scene.root}`,
        "profileDirectory=Default",
        `profileId=${ALICE}`,
        "namespace=lab",
        `downloadsRoot=${scene.home}/Downloads`,
        "root=r1\n", // the catalog pass of start --once numbered the root
      ].join("\n"),
    ]);
    assert.ok(existsSync(`${scene.home}/Downloads/RECnRun/poc/lab/registry.json`));
    assert.equal(scene.launches(), 1);
    assert.equal(scene.field("status"), "open");
  });

  await test(`${shell}: first-run twice registers once and opens once`, (context) => {
    const scene = firstRunScene(context);
    assert.equal(firstRun(shell, explicit(scene), vars(scene)).code, 0);
    const again = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /already registered/);
    assert.equal(blocks(scene.record).length, 1);
    assert.equal(scene.launches(), 1, "the open profile was not opened again");
  });

  await test(`${shell}: first-run without arguments uses the defaults below HOME`, (context) => {
    const scene = firstRunScene(context);
    const result = firstRun(shell, [], vars(scene));
    assert.equal(result.code, 0, result.err);
    const record = join(scene.home, ".recnrun/launcher.record");
    assert.match(readFileSync(record, "utf8"), new RegExp(`profileId=${ALICE}\nnamespace=lab\n`));
    assert.equal(
      lines(result.out).at(-1),
      `next: sh recnrun-launcher autostart on ${scene.home}/.recnrun/launcher ${record} lab`,
    );
  });

  await test(`${shell}: first-run registers nothing for a profile with no presence that does not ack`, (context) => {
    const scene = firstRunScene(context);
    scene.unpublish();
    const result = firstRun(shell, explicit(scene), vars(scene, { STUB_ACK: "" }));
    assert.equal(result.code, EX_FAILED);
    assert.match(result.err, /Default of .*: did not ack/);
    assert.equal(existsSync(scene.record), false);
  });

  await test(`${shell}: first-run exits 66 when no profile has the extension`, (context) => {
    const scene = firstRunScene(context);
    writeFileSync(join(scene.root, "Default/Preferences"), "{}");
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, EX_NONE);
    assert.match(result.err, /no profile with the extension/);
    assert.equal(scene.launches(), 0);
  });

  await test(`${shell}: first-run binds a profile with no presence through its ack`, (context) => {
    const scene = firstRunScene(context);
    scene.unpublish();
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
    assert.equal(blocks(scene.record).length, 1);
  });

  await test(`${shell}: first-run exits 70 when the profile never acks`, (context) => {
    const scene = firstRunScene(context);
    const result = firstRun(shell, explicit(scene), vars(scene, { STUB_ACK: "" }));
    assert.equal(result.code, EX_FAILED);
    assert.notEqual(lines(result.out)[0], `${ALICE} open`);
    assert.match(result.err, /a profile did not open/);
  });

  await test(`${shell}: first-run refuses a wrong call, a relative path, and a space in HOME`, (context) => {
    const scene = firstRunScene(context);
    const run = (args, extra) => firstRun(shell, args, vars(scene, extra));
    assert.equal(run(["one"]).code, EX_USAGE);
    assert.equal(run([scene.state, scene.record]).code, EX_USAGE);
    assert.equal(run(["state", scene.record, "lab"]).code, EX_REFUSED);
    assert.equal(run([scene.state, "launcher.record", "lab"]).code, EX_REFUSED);
    assert.equal(run([scene.state, scene.record, "Lab_1"]).code, EX_REFUSED);
    assert.equal(run([`${scene.state}/a b`, scene.record, "lab"]).code, EX_REFUSED);
    assert.equal(run([], { HOME: "/tmp/with space" }).code, EX_REFUSED);
    assert.equal(scene.launches(), 0);
  });
}

const recordBlock = (scene, id, directory) =>
  [
    `userDataDir=${scene.root}`,
    `profileDirectory=${directory}`,
    `profileId=${id}`,
    "namespace=lab",
    `downloadsRoot=${scene.home}/Downloads`,
  ].join("\n");
const trimmed = (record) => blocks(record).map((block) => block.trimEnd());

for (const shell of shells) {
  await test(`${shell}: first-run binds both profiles of a shared Downloads root with their acked ids`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(trimmed(scene.record), [
      recordBlock(scene, ALICE, "Default"),
      recordBlock(scene, BOB, "Profile 1"),
    ]);
    assert.deepEqual(lines(result.out).slice(0, 2), [`${ALICE} open`, `${BOB} open`]);
    assert.doesNotMatch(result.err, /skipped/);
  });

  await test(`${shell}: first-run binds a profile whose extension has not written a presence yet`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    scene.unpublish(BOB);
    scene.unpublish(ALICE);
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(trimmed(scene.record), [
      recordBlock(scene, ALICE, "Default"),
      recordBlock(scene, BOB, "Profile 1"),
    ]);
  });

  await test(`${shell}: first-run leaves out a profile that never acks and exits 70 naming it`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    scene.ack({ Default: ALICE });
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, EX_FAILED);
    assert.match(result.err, /Profile 1 of .*: did not ack/);
    assert.deepEqual(trimmed(scene.record), [recordBlock(scene, ALICE, "Default")]);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
  });

  await test(`${shell}: first-run exits 70 when no profile of a shared root acks`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    scene.ack({});
    const result = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(result.code, EX_FAILED);
    assert.match(result.err, /Default of .*: did not ack/);
    assert.match(result.err, /Profile 1 of .*: did not ack/);
    assert.equal(existsSync(scene.record), false);
  });

  await test(`${shell}: first-run leaves a registered profile of a shared root alone`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    assert.equal(firstRun(shell, explicit(scene), vars(scene)).code, 0);
    const before = readFileSync(scene.record, "utf8");
    const launches = scene.launches();
    const again = firstRun(shell, explicit(scene), vars(scene));
    assert.equal(again.code, 0, again.err);
    assert.equal(readFileSync(scene.record, "utf8"), before);
    assert.equal(scene.launches(), launches, "nothing was bound or opened again");
  });
}
