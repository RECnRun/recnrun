import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordVerified, verifiedMarker } from "../verified-commit.mjs";

const hook = fileURLToPath(new URL("./pre-push.mjs", import.meta.url));

function repository(context) {
  const repo = mkdtempSync(join(tmpdir(), "pre-push-"));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "checks@recnrun.invalid");
  git("config", "user.name", "Checks");
  writeFileSync(join(repo, ".gitignore"), ".artifacts/\n");
  writeFileSync(join(repo, "flow.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  return { repo, head: git("rev-parse", "HEAD"), git };
}

function mark(repo, head) {
  mkdirSync(join(repo, ".artifacts/verified"), { recursive: true });
  writeFileSync(join(repo, ".artifacts/verified", head), "run-id\n");
}

// Runs the hook as Git would, with a fake `vp` that records its arguments and exits with `status`.
function push(context, repo, status = 0) {
  const bin = mkdtempSync(join(tmpdir(), "pre-push-bin-"));
  context.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "vp"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit ${status}\n`);
  chmodSync(join(bin, "vp"), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const result = spawnSync(process.execPath, [hook], { cwd: repo, env, encoding: "utf8" });
  return { ...result, verified: existsSync(calls) };
}

test("a marker for the clean HEAD skips verify and names the marker", (context) => {
  const { repo, head } = repository(context);
  mark(repo, head);
  const result = push(context, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verified, false);
  assert.match(result.stdout, new RegExp(`\\.artifacts/verified/${head}`));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a dirty tree runs verify even with a marker for HEAD", (context) => {
  const { repo, head } = repository(context);
  mark(repo, head);
  writeFileSync(join(repo, "flow.ts"), "export const changed = 1;\n");
  assert.equal(push(context, repo).verified, true);
});

test("an untracked file counts as a dirty tree", (context) => {
  const { repo, head } = repository(context);
  mark(repo, head);
  writeFileSync(join(repo, "notes.ts"), "export {};\n");
  assert.equal(push(context, repo).verified, true);
});

test("no marker for HEAD runs verify and returns its exit code", (context) => {
  const { repo, head, git } = repository(context);
  mark(repo, head);
  writeFileSync(join(repo, "flow.ts"), "export const next = 2;\n");
  git("commit", "-q", "-am", "Move on");
  const result = push(context, repo, 3);
  assert.equal(result.verified, true);
  assert.equal(result.status, 3);
});

test("records a passing verify only when HEAD stayed the same clean commit", async (context) => {
  const { repo, head, git } = repository(context);
  assert.equal(verifiedMarker(repo), undefined);
  assert.equal(await recordVerified(repo, undefined, "run"), undefined);
  writeFileSync(join(repo, "notes.ts"), "export {};\n");
  assert.equal(await recordVerified(repo, head, "run"), undefined);
  git("add", ".");
  git("commit", "-q", "-m", "Add notes");
  assert.equal(await recordVerified(repo, head, "run"), undefined);
  const marker = await recordVerified(repo, git("rev-parse", "HEAD"), "run-7");
  assert.equal(marker, join(repo, ".artifacts/verified", git("rev-parse", "HEAD")));
  assert.equal(verifiedMarker(repo), marker);
});
