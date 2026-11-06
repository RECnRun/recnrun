import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";

const vars = (scene, extra = {}) => scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2", ...extra });
const explicit = (scene) => [scene.state, scene.record, "lab"];

/** Runs `body` on a scene with nothing readable in the Chrome root: no Preferences, and no access when not root. */
function unreadable(context, body) {
  const scene = firstRunScene(context);
  rmSync(join(scene.root, "Default/Preferences"));
  chmodSync(scene.root, 0o000);
  try {
    body(scene);
  } finally {
    chmodSync(scene.root, 0o755);
  }
}

for (const shell of shells) {
  await test(`${shell}: first-run registers the Default by its token ack without reading Chrome's root`, (context) =>
    unreadable(context, (scene) => {
      const result = firstRun(shell, explicit(scene), vars(scene));
      assert.equal(result.code, 0, result.err);
      assert.equal(lines(result.out)[0], `${ALICE} open`);
      const record = readFileSync(scene.record, "utf8");
      assert.match(record, new RegExp(`profileDirectory=Default\nprofileId=${ALICE}\n`));
      assert.match(record, new RegExp(`downloadsRoot=${scene.home}/Downloads\nrole=master`));
      assert.equal(scene.launches(), 1);
    }));

  await test(`${shell}: first-run without an ack names the extension and --downloads`, (context) =>
    unreadable(context, (scene) => {
      const result = firstRun(shell, explicit(scene), vars(scene, { STUB_ACK: "" }));
      assert.equal(result.code, 70);
      assert.match(result.err, /load the extension in the Default/);
      assert.match(result.err, /--downloads/);
      assert.equal(existsSync(scene.record), false);
    }));

  await test(`${shell}: first-run --downloads gives the Default's Downloads root`, (context) =>
    unreadable(context, (scene) => {
      scene.unpublish();
      const elsewhere = mkdtempSync(join(tmpdir(), "recnrun-dl-"));
      context.after(() => rmSync(elsewhere, { recursive: true, force: true }));
      const env = vars(scene, { STUB_ROOT: elsewhere });
      assert.equal(
        firstRun(shell, explicit(scene), env).code,
        70,
        "outside HOME and Downloads: not found",
      );
      const result = firstRun(shell, ["--downloads", elsewhere, ...explicit(scene)], env);
      assert.equal(result.code, 0, result.err);
      assert.match(readFileSync(scene.record, "utf8"), new RegExp(`downloadsRoot=${elsewhere}\n`));
      assert.equal(firstRun(shell, ["--downloads", "relative", ...explicit(scene)], env).code, 65);
    }));
}
