import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordVerified, verifiedMarker } from "../verified-commit.mjs";

const hook = fileURLToPath(new URL("./pre-push.mjs", import.meta.url));
const ZERO = "0".repeat(40);

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

/** A commit on a branch of its own, so a push can name a commit that is not HEAD. */
function branch({ repo, git }, name) {
  git("checkout", "-q", "-b", name);
  writeFileSync(join(repo, "flow.ts"), `export const ${name} = 1;\n`);
  git("commit", "-q", "-am", `Work on ${name}`);
  const sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-");
  return sha;
}

function mark(repo, sha) {
  mkdirSync(join(repo, ".artifacts/verified"), { recursive: true });
  writeFileSync(join(repo, ".artifacts/verified", sha), "run-id\n");
}

/** One line of the hook's stdin: a push of `sha` to `ref`; the zero sha deletes the remote ref. */
const update = (sha, ref = "refs/heads/main") => `${ref} ${sha} ${ref} ${ZERO}\n`;

// Runs the hook as Git would, with `input` on stdin and a fake `vp` that records its calls and exits with `status`.
function push(context, repo, input, status = 0) {
  const bin = mkdtempSync(join(tmpdir(), "pre-push-bin-"));
  context.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "vp"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit ${status}\n`);
  chmodSync(join(bin, "vp"), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const result = spawnSync(process.execPath, [hook], { cwd: repo, env, encoding: "utf8", input });
  const verified = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return { ...result, verified: verified.length > 0, calls: verified };
}

test("a marker for the pushed HEAD skips verify and names the marker", (context) => {
  const { repo, head } = repository(context);
  mark(repo, head);
  const result = push(context, repo, update(head));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verified, false);
  assert.match(result.stdout, new RegExp(`\\.artifacts/verified/${head}`));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a marker for the pushed commit counts even when the tree is dirty", (context) => {
  const { repo, head } = repository(context);
  mark(repo, head);
  writeFileSync(join(repo, "flow.ts"), "export const changed = 1;\n");
  const result = push(context, repo, update(head));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verified, false);
});

test("no marker for the clean HEAD runs verify and returns its exit code", (context) => {
  const { repo, head, git } = repository(context);
  mark(repo, head);
  writeFileSync(join(repo, "flow.ts"), "export const next = 2;\n");
  git("commit", "-q", "-am", "Move on");
  const result = push(context, repo, update(git("rev-parse", "HEAD")), 3);
  assert.deepEqual(result.calls, ["run verify"]);
  assert.equal(result.status, 3);
});

test("no marker for HEAD on a dirty tree fails without running verify", (context) => {
  const { repo, head } = repository(context);
  writeFileSync(join(repo, "notes.ts"), "export {};\n");
  const result = push(context, repo, update(head));
  assert.equal(result.status, 1);
  assert.equal(result.verified, false);
  assert.match(result.stderr, new RegExp(`${head}.*vp run verify`));
});

test("a pushed commit that is not HEAD skips verify with its marker", (context) => {
  const repository_ = repository(context);
  const feature = branch(repository_, "feature");
  mark(repository_.repo, feature);
  const result = push(context, repository_.repo, update(feature, "refs/heads/feature"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verified, false);
  assert.match(result.stdout, new RegExp(`\\.artifacts/verified/${feature}`));
});

test("a pushed commit that is not HEAD fails without a marker, even when HEAD has one", (context) => {
  const repository_ = repository(context);
  mark(repository_.repo, repository_.head);
  const feature = branch(repository_, "feature");
  const result = push(context, repository_.repo, update(feature, "refs/heads/feature"));
  assert.equal(result.status, 1);
  assert.equal(result.verified, false);
  assert.match(result.stderr, new RegExp(`${feature}.*vp run verify`));
  assert.doesNotMatch(result.stderr, new RegExp(repository_.head));
});

test("several refs: verify runs once for the unmarked HEAD and the marked commit is skipped", (context) => {
  const repository_ = repository(context);
  const feature = branch(repository_, "feature");
  mark(repository_.repo, feature);
  const input = update(repository_.head) + update(feature, "refs/heads/feature");
  const result = push(context, repository_.repo, input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["run verify"]);
});

test("several refs: an unmarked commit that is not HEAD fails the push before verify", (context) => {
  const repository_ = repository(context);
  mark(repository_.repo, repository_.head);
  const feature = branch(repository_, "feature");
  const input = update(repository_.head) + update(feature, "refs/heads/feature");
  const result = push(context, repository_.repo, input);
  assert.equal(result.status, 1);
  assert.equal(result.verified, false);
});

test("a push that deletes a remote ref needs no verify", (context) => {
  const { repo } = repository(context);
  const result = push(context, repo, update(ZERO, "refs/heads/feature"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verified, false);
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
