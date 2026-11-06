import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { CLONE, controlScene } from "./clone-control-lab.mjs";

/** The safety and ordering rules of clone-control.sh that the Codex plan review added (P7.5). */
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

for (const shell of shells) {
  await test(`${shell}: a newer request for the clone supersedes an older pending one`, (context) => {
    const s = controlScene(context);
    s.write({ action: "open-visible", createdAt: Date.now() - 2000 });
    s.write({ action: "close", createdAt: Date.now() - 1000 }, SECOND);
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.match(s.status().message, /superseded by a newer request/);
    assert.equal(s.status(SECOND).state, "done", s.status(SECOND).raw);
    assert.equal(s.launches(), 0);
    assert.equal(s.field("status", CLONE), "stopped");
  });

  await test(`${shell}: an older request delivered after a newer one was handled is refused`, (context) => {
    const s = controlScene(context);
    s.write({ action: "close", createdAt: Date.now() - 1000 }, SECOND);
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status(SECOND).state, "done", s.status(SECOND).raw);
    s.write({ action: "open-visible", createdAt: Date.now() - 2000 });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.match(s.status().message, /older than a request already handled/);
    assert.equal(s.launches(), 0);
    assert.equal(s.field("status", CLONE), "stopped");
    s.write(
      { action: "open-visible", createdAt: Date.now() },
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status("cccccccc-cccc-4ccc-8ccc-cccccccccccc").state, "done");
  });

  await test(`${shell}: of several pending requests only the newest for the clone runs, in one pass`, (context) => {
    const s = controlScene(context);
    const THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    s.write({ action: "open-headless", createdAt: Date.now() - 3000 });
    assert.equal(s.run(shell).code, 0);
    s.write({ action: "reopen-headless", createdAt: Date.now() - 2000 }, SECOND);
    s.write({ action: "reopen-visible", createdAt: Date.now() - 1000 }, THIRD);
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status(SECOND).state, "refused", s.status(SECOND).raw);
    assert.equal(s.status(THIRD).state, "done", s.status(THIRD).raw);
    assert.equal(s.field("mode", CLONE), "headed");
  });

  await test(`${shell}: a clone root below a linked folder is refused and nothing runs`, (context) => {
    const s = controlScene(context);
    renameSync(join(s.home, "bases"), join(s.home, "bases-real"));
    symlinkSync(join(s.home, "bases-real"), join(s.home, "bases"));
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: two worker blocks for one instance are refused`, (context) => {
    const s = controlScene(context);
    const block = `\nuserDataDir=${s.root}\nprofileDirectory=Default\nprofileId=${CLONE}\nnamespace=${NAMESPACE}\nrole=worker\n`;
    appendFileSync(s.record, block);
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: an earlier block of another role with the same id is refused and nothing runs`, (context) => {
    const s = controlScene(context);
    const block = `userDataDir=${s.stray}\nprofileDirectory=Default\nprofileId=${CLONE}\nnamespace=${NAMESPACE}\nrole=template\n\n`;
    writeFileSync(s.record, block + readFileSync(s.record, "utf8"));
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.match(s.status().message, /more than one block/);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: a worker block with a profile other than Default is refused`, (context) => {
    const s = controlScene(context);
    edit(
      s.record,
      `profileDirectory=Default\nprofileId=${CLONE}`,
      `profileDirectory=Profile 1\nprofileId=${CLONE}`,
    );
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: an open attempt under way refuses the request`, (context) => {
    const s = controlScene(context);
    assert.equal(s.request(shell, {}, CLONE, "headed").code, 0);
    edit(s.stateFile(CLONE), /^status=.*$/m, "status=opening");
    edit(s.stateFile(CLONE), /^startedAt=.*$/m, `startedAt=${Math.floor(Date.now() / 1000)}`);
    s.write({ action: "close" });
    assert.equal(s.run(shell, { RECNRUN_OPEN_TIMEOUT_S: "60" }).code, 0);
    assert.equal(s.status().state, "refused", s.status().raw);
    assert.match(s.status().message, /under way/);
    assert.deepEqual(s.signals(), []);
  });

  await test(`${shell}: a reopen whose close timed out does not open again`, (context) => {
    const s = controlScene(context, { STUB_DEAF: "1" });
    assert.equal(s.request(shell, {}, CLONE, "headless").code, 0);
    s.write({ action: "reopen-visible" });
    assert.equal(s.run(shell, { RECNRUN_LIFECYCLE_STOP_S: "1" }).code, 0);
    assert.equal(s.status().state, "error", s.status().raw);
    assert.equal(s.launches(), 1);
    assert.equal(s.field("status", CLONE), "stopped");
  });

  await test(`${shell}: a successful open is listed in control/opened for the launcher`, (context) => {
    const s = controlScene(context);
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(readFileSync(join(s.state, "control/opened"), "utf8"), `${CLONE}\n`);
  });
}
