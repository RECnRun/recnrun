import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./pre-tool-use.mjs", import.meta.url));

function decision(command) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision
    : undefined;
}

await test("blocks obvious Git hook bypasses", () => {
  for (const command of [
    "git commit --no-verify -m update",
    "git commit -n -m update",
    "git push --no-verify",
    "git -c core.hooksPath=/dev/null commit -m update",
    "VP_GIT_HOOKS=0 git push",
    "git config core.hooksPath /dev/null",
    "vp hooks disable",
  ]) {
    assert.equal(decision(command), "deny", command);
  }
});

await test("allows ordinary Git commands and read-only hook inspection", () => {
  for (const command of ["git commit -m update", "git push", "git config --get core.hooksPath"]) {
    assert.equal(decision(command), undefined, command);
  }
});
