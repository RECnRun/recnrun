import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./stop.mjs", import.meta.url));

function executable(bin, name, script) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

// Fake git and vp keep the hook independent of the checkout (the test container has no .git).
function fakeVp(exitCode, failingCommand = "check") {
  const bin = mkdtempSync(join(tmpdir(), "fake-vp-"));
  executable(bin, "git", `echo "${bin}"`);
  executable(
    bin,
    "vp",
    // Like vp: diagnostics on stdout, a one-line summary on stderr.
    `case "$*" in *${failingCommand}*) echo "fake vp ${failingCommand} diagnostic"; echo "fake vp ${failingCommand} failure" >&2; exit ${exitCode};; esac`,
  );
  return bin;
}

function stopHook(bin, state, stopHookActive) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: bin, session_id: "checks", stop_hook_active: stopHookActive }),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: state },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

await test("allows the stop when vp check passes", () => {
  const output = stopHook(fakeVp(0), mkdtempSync(join(tmpdir(), "stop-state-")), false);
  assert.equal(output.decision, undefined);
});

await test("allows the stop after three consecutive blocks so an agent cannot loop", () => {
  const bin = fakeVp(1);
  const state = mkdtempSync(join(tmpdir(), "stop-state-"));
  for (const active of [false, true, true]) {
    const output = stopHook(bin, state, active);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /fake vp check failure/);
  }
  const released = stopHook(bin, state, true);
  assert.equal(released.decision, undefined);
  assert.match(released.systemMessage, /Quality checks still fail/);
  assert.equal(stopHook(bin, state, false).decision, "block", "a new turn starts counting again");
});

await test("reports the diagnostics, not only the summary", () => {
  const output = stopHook(fakeVp(1), mkdtempSync(join(tmpdir(), "stop-state-")), false);
  assert.match(output.reason, /fake vp check diagnostic/);
  assert.match(output.reason, /fake vp check failure/);
});

await test("blocks the stop when dependency rules fail", () => {
  const output = stopHook(fakeVp(1, "deps"), mkdtempSync(join(tmpdir(), "stop-state-")), false);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /vp run --no-cache deps failed/);
});
