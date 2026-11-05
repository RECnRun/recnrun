import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ALICE, NAMESPACE, shells, until } from "./lab.mjs";
import { alive, env, life, scene, script } from "./lifecycle-lab.mjs";

const EX_PAUSED = 73;

/** A request that runs in the background; resolves to its exit code and stderr. */
function background(shell, s, extra) {
  return new Promise((resolve) => {
    const child = spawn(shell, [script, "request", s.state, s.record, NAMESPACE, ALICE], {
      env: env(s.vars(extra)),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, err }));
  });
}

/** True once the state file names a pid; the file may not exist yet. */
function recorded(s) {
  try {
    return Boolean(s.field("pid"));
  } catch {
    return false;
  }
}

for (const shell of shells) {
  await test(`${shell}: a pause issued during the open wins and the pid stays recorded`, async (context) => {
    const s = scene(context, { STUB_DELAY: "2" });
    const request = background(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "10" });
    await until(() => recorded(s));
    assert.equal(life(shell, ["pause", s.state, ALICE], {}).code, 0);
    const done = await request;
    assert.equal(done.code, EX_PAUSED, done.err);
    assert.match(done.err, /paused while it was opening/);
    assert.equal(s.field("status"), "paused");
    assert.ok(alive(Number(s.field("pid"))), "the Chrome of the open stays reachable for stop");
    assert.match(s.field("token") ?? "", /^[0-9a-f-]{36}$/);
  });

  await test(`${shell}: a timeout after a stop leaves the profile stopped`, async (context) => {
    const s = scene(context, { STUB_ACK: "" });
    const request = background(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "3" });
    await until(() => recorded(s));
    const stopped = life(
      shell,
      ["stop", s.state, ALICE],
      s.vars({ RECNRUN_LIFECYCLE_STOP_S: "5" }),
    );
    assert.equal(stopped.code, 0, stopped.err);
    const done = await request;
    assert.equal(done.code, EX_PAUSED, done.err);
    assert.match(done.err, /stopped while it was opening/);
    assert.equal(s.field("status"), "stopped");
    assert.equal(s.field("attempts"), "0", "the timeout of a cancelled attempt is not a failure");
  });

  await test(`${shell}: the result of an attempt that a newer one replaced is dropped`, async (context) => {
    const s = scene(context, { STUB_DELAY: "2" });
    const request = background(shell, s, { RECNRUN_OPEN_TIMEOUT_S: "10" });
    await until(() => recorded(s));
    const text = readFileSync(s.stateFile(), "utf8");
    const newer = text.replace(
      /^startedAt=(\d+)$/m,
      (_, started) => `startedAt=${Number(started) + 7}`,
    );
    writeFileSync(s.stateFile(), newer);
    const done = await request;
    assert.equal(done.code, EX_PAUSED, done.err);
    assert.match(done.err, /replaced by a newer attempt/);
    assert.equal(readFileSync(s.stateFile(), "utf8"), newer, "the newer state was not touched");
  });
}
