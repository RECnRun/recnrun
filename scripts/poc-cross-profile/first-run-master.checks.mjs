import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ALICE, BOB, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";

const vars = (scene, extra = {}) => scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2", ...extra });
const run = (shell, scene, extra) =>
  firstRun(shell, [scene.state, scene.record, "lab"], vars(scene, extra));
const text = (scene) => readFileSync(scene.record, "utf8");
const roles = (scene) =>
  text(scene)
    .split("\n")
    .filter((line) => line.startsWith("role="));
const masterOpens = (scene) => {
  const file = join(scene.home, "launches.txt.urls");
  if (!existsSync(file)) return 0;
  return lines(readFileSync(file, "utf8")).filter((url) => url.endsWith("&role=master")).length;
};
const block = (scene, id, directory, extra = "") =>
  `userDataDir=${scene.root}\nprofileDirectory=${directory}\nprofileId=${id}\nnamespace=lab\ndownloadsRoot=${scene.home}/Downloads\n${extra}`;

for (const shell of shells) {
  await test(`${shell}: first-run makes the registered Default the master, once`, (context) => {
    const scene = firstRunScene(context);
    const result = run(shell, scene);
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `${ALICE} open`);
    assert.deepEqual(roles(scene), ["role=master"]);
    assert.equal(masterOpens(scene), 1);
    assert.deepEqual(
      readdirSync(dirname(scene.record)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    const again = run(shell, scene);
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(roles(scene), ["role=master"]);
    assert.equal(masterOpens(scene), 1, "a master Default is not asked again");
  });

  await test(`${shell}: first-run gives an already registered Default with no role the master`, (context) => {
    const scene = firstRunScene(context);
    writeFileSync(scene.record, block(scene, ALICE, "Default"));
    const result = run(shell, scene);
    assert.equal(result.code, 0, result.err);
    assert.match(text(scene), new RegExp(`profileId=${ALICE}\n[^\n]*\n?[^]*role=master`));
    assert.equal(masterOpens(scene), 1);
  });

  await test(`${shell}: first-run leaves the record alone when the namespace has a master already`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    writeFileSync(
      scene.record,
      `${block(scene, ALICE, "Default")}\n${block(scene, BOB, "Profile 1", "role=master\n")}`,
    );
    const result = run(shell, scene);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(roles(scene), ["role=master"]);
    assert.doesNotMatch(
      text(scene),
      new RegExp(`profileId=${ALICE}[^]*role=master[^]*profileId=${BOB}`),
    );
    assert.equal(masterOpens(scene), 0);
  });

  await test(`${shell}: first-run never lists another profile of the default root, so none becomes the master`, (context) => {
    const scene = firstRunScene(context, "lab", { shared: true });
    scene.ack({ "Profile 1": BOB });
    const result = run(shell, scene);
    assert.equal(result.code, 70, result.err);
    assert.equal(existsSync(scene.record), false, "no profile, so no role");
    assert.equal(masterOpens(scene), 1, "only the Default was asked");
    assert.doesNotMatch(result.err, /Profile 1/);
  });

  await test(`${shell}: first-run writes no role when the Default does not confirm and exits 70`, (context) => {
    const scene = firstRunScene(context);
    // The Default is bound with its master claim, so a claim that is not acked leaves it unregistered.
    const result = run(shell, scene, { STUB_MASTER_FAIL: "1" });
    assert.equal(result.code, 70);
    assert.match(result.err, /did not ack/);
    assert.equal(existsSync(scene.record), false);
    const retry = run(shell, scene);
    assert.equal(retry.code, 0, retry.err);
    assert.deepEqual(roles(scene), ["role=master"]);
  });
}
