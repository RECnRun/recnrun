import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { launch, root } from "./launch.mjs";

// A clean Git checkout holding the runner, so verify:local can record its marker there.
function checkout(context) {
  const repo = mkdtempSync(join(tmpdir(), "recnrun-checkout-"));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "scripts"));
  for (const file of ["test-container.mjs", "verified-commit.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(repo, "scripts", file));
  }
  writeFileSync(join(repo, ".gitignore"), ".artifacts/\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Checks",
    "-c",
    "user.email=checks@recnrun.invalid",
    "commit",
    "-qm",
    "Start",
  );
  return { repo, head: git("rev-parse", "HEAD"), script: join(repo, "scripts/test-container.mjs") };
}

await test("a passing verify on a clean checkout records its run id for the commit", async (context) => {
  const { repo, head, script } = checkout(context);
  const env = { RECNRUN_TEST_ARTIFACTS: join(repo, ".artifacts/docker") };
  const result = await launch(context, "success", [], { task: "verify:local", script, env });
  assert.equal(result.code, 0, result.output);
  const marker = readFileSync(join(repo, ".artifacts/verified", head), "utf8").trim();
  assert.equal(marker, basename(result.artifacts));
});

await test("a failing, dirty, or dirtied verify records no marker", async (context) => {
  for (const [scenario, dirty] of [
    ["test-failure", false],
    ["success", true],
    ["dirty-during", false],
  ]) {
    const { repo, script } = checkout(context);
    if (dirty) writeFileSync(join(repo, "notes.txt"), "Uncommitted");
    const env = { DOCKER_FIXTURE_TOUCH: join(repo, "touched.txt") };
    const result = await launch(context, scenario, [], { task: "verify:local", script, env });
    assert.ok(
      result.calls.some(([command]) => command === "start"),
      scenario,
    );
    assert.equal(existsSync(join(repo, ".artifacts/verified")), false, scenario);
  }
});
