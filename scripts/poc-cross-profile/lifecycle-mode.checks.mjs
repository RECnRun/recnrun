import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ALICE, NAMESPACE, shells } from "./lab.mjs";
import { commandScene, launcher } from "./commands-lab.mjs";
import { alive, life, scene } from "./lifecycle-lab.mjs";

const EX_REFUSED = 65;
const start = (shell, s) =>
  launcher(shell, ["start", s.state, s.record, NAMESPACE, "--once"], s.vars());
const headlessLaunches = (s) => s.argv().filter((line) => line.includes("--headless"));
const ownLaunches = (s) => s.argv().filter((line) => line.includes(`--user-data-dir=${s.root} `));

/** Ends the Chrome of the profile the way a crash does and waits until it is gone. */
async function crash(s) {
  const pid = Number(s.field("pid"));
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
}

for (const shell of shells) {
  await test(`${shell}: a headless clone whose pid dies relaunches headless`, async (context) => {
    const s = commandScene(context);
    assert.equal(s.request(shell, {}, ALICE, "headless").code, 0);
    assert.equal(s.field("mode"), "headless");
    await crash(s);
    assert.equal(start(shell, s).code, 0);
    assert.equal(ownLaunches(s).length, 2, s.argv().join("\n"));
    assert.equal(headlessLaunches(s).length, 2, s.argv().join("\n"));
    assert.equal(s.field("mode"), "headless");
  });

  await test(`${shell}: a state with no mode relaunches headed`, async (context) => {
    const s = commandScene(context);
    assert.equal(s.request(shell, {}, ALICE, "headed").code, 0);
    assert.equal(s.field("mode"), "headed");
    const file = s.stateFile();
    writeFileSync(file, readFileSync(file, "utf8").replace(/^mode=.*\n/m, ""));
    await crash(s);
    assert.equal(start(shell, s).code, 0);
    assert.equal(ownLaunches(s).length, 2, s.argv().join("\n"));
    assert.equal(headlessLaunches(s).length, 0, s.argv().join("\n"));
    assert.equal(s.field("mode"), "headed");
  });

  await test(`${shell}: adopt records the mode the running Chrome has`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell, {}, ALICE, "headless").code, 0);
    const file = s.stateFile();
    writeFileSync(file, readFileSync(file, "utf8").replace(/^mode=.*\n/m, ""));
    const boot = "44444444-4444-4444-8444-444444444444";
    const args = ["adopt", s.state, s.record, NAMESPACE, ALICE, `${s.home}/Downloads`, boot];
    const adopted = life(shell, args, s.vars());
    assert.equal(adopted.code, 0, adopted.err);
    assert.equal(s.field("mode"), "headless");
  });

  await test(`${shell}: a mode outside headed and headless is refused like any bad state`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    const file = s.stateFile();
    writeFileSync(file, readFileSync(file, "utf8").replace(/^mode=.*$/m, "mode=sideways"));
    const refused = s.request(shell);
    assert.equal(refused.code, EX_REFUSED, refused.err);
    assert.match(refused.err, /state file .*: invalid mode/);
  });
}
