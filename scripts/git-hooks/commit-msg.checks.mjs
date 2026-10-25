import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitMessageErrors } from "./commit-msg.mjs";

const hook = fileURLToPath(new URL("./commit-msg.mjs", import.meta.url));
const trailer = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const evidence =
  "Red: vp run test:unit failed: expected 1 recording.\nGreen: vp run test:unit passes.";

await test("accepts a capitalized imperative subject under 72 characters", () => {
  assert.deepEqual(commitMessageErrors("Add source aliases for workspace packages", []), []);
  assert.deepEqual(commitMessageErrors(`${"A".repeat(71)}\n`, ["docs/ARCHITECTURE.md"]), []);
});

await test("rejects subject format violations", () => {
  for (const subject of [
    "feat: add source aliases",
    "fix(feed)!: stop the scroll",
    "add source aliases",
    "Add source aliases.",
    "A".repeat(72),
  ]) {
    assert.notDeepEqual(commitMessageErrors(subject, []), [], subject);
  }
  assert.notDeepEqual(commitMessageErrors("", []), []);
});

await test("requires a blank line between subject and body", () => {
  assert.notDeepEqual(commitMessageErrors("Add aliases\nBecause imports broke", []), []);
  assert.deepEqual(commitMessageErrors("Add aliases\n\nBecause imports broke", []), []);
});

await test("source changes need red/green evidence and a staged test", () => {
  const source = ["apps/website/src/features/explorer/explorer.ts"];
  const withTest = [...source, "apps/website/tests/explorer.browser.test.tsx"];
  assert.notDeepEqual(commitMessageErrors(`Fix the explorer list\n\n${trailer}`, withTest), []);
  assert.notDeepEqual(commitMessageErrors(`Fix the explorer list\n\n${evidence}`, source), []);
  assert.deepEqual(
    commitMessageErrors(`Fix the explorer list\n\n${evidence}\n\n${trailer}`, withTest),
    [],
  );
  for (const path of [
    "packages/domain/src/recording.ts",
    "apps/extension/src/background/handler.ts",
    "apps/website/src/ui/banner.css",
  ]) {
    assert.notDeepEqual(commitMessageErrors("Change behavior", [path]), [], path);
  }
  for (const test of [
    "tests/e2e/explorer.spec.ts",
    "packages/domain/tests/recording.test.ts",
    "scripts/git-hooks/commit-msg.checks.mjs",
  ]) {
    assert.deepEqual(commitMessageErrors(`Fix it\n\n${evidence}`, [...source, test]), [], test);
  }
});

await test("an explicit no-behavior-change line exempts source changes", () => {
  const message = "Rename the recording helper\n\nNo-behavior-change: mechanical rename.";
  assert.deepEqual(commitMessageErrors(message, ["packages/domain/src/recording.ts"]), []);
  assert.notDeepEqual(
    commitMessageErrors("Rename it\n\nNo-behavior-change:", ["packages/domain/src/recording.ts"]),
    [],
  );
});

await test("ignores Git comments, verbose diffs, and generated merge or fixup subjects", () => {
  const verbose = `Add aliases\n# Please enter the commit message\n# ------------------------ >8 ------------------------\nfeat: diff text`;
  assert.deepEqual(commitMessageErrors(verbose, []), []);
  for (const subject of ["Merge branch 'master' into feature", "fixup! Add aliases", "squash! x"]) {
    assert.deepEqual(commitMessageErrors(subject, ["apps/website/src/main.tsx"]), [], subject);
  }
});

await test("the hook rejects a bad message for staged source in a real commit", () => {
  const repo = mkdtempSync(join(tmpdir(), "commit-msg-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  execFileSync("mkdir", ["-p", join(repo, "apps/website/src")]);
  writeFileSync(join(repo, "apps/website/src/main.tsx"), "export {};\n");
  git("add", ".");
  const message = join(repo, "MSG");
  const run = (text) => {
    writeFileSync(message, text);
    return spawnSync(process.execPath, [hook, message], { cwd: repo, encoding: "utf8" });
  };
  const rejected = run("feat: change main\n");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Conventional Commit prefix/);
  assert.match(rejected.stderr, /Red:/);
  assert.equal(run("Change main\n\nNo-behavior-change: empty module.\n").status, 0);
});
