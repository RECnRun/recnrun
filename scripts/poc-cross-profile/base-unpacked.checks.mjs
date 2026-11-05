import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { EXTENSION, MARKER, baseScene, installExtension } from "./base-lab.mjs";

const EX_NO_CODE = 66;
const lines = (text) => text.split("\n").filter(Boolean);

for (const shell of shells) {
  await test(`${shell}: template refuses while the unpacked build is gone and goes on once it is back`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    const build = installExtension(s.root(), { unpacked: true });
    const template = () =>
      s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", { STUB_ACK: "good" });
    const launched = s.launchCount();
    renameSync(build, `${build}-away`);
    const gone = template();
    assert.equal(gone.code, EX_NO_CODE, gone.err);
    assert.match(gone.err, new RegExp(`unpacked code missing: ${build}\n`));
    assert.equal(s.launchCount(), launched, "Chrome never started");
    renameSync(`${build}-away`, build);
    assert.equal(template().code, 0);
  });

  await test(`${shell}: freeze records the unpacked path as a seventh line and a packed install has none`, (context) => {
    const packed = baseScene(context);
    assert.equal(packed.create(shell).code, 0);
    installExtension(packed.root());
    const ack = { STUB_ACK: "good" };
    assert.equal(
      packed.run(shell, ["template", packed.bases, "base-v1", NAMESPACE], "base-v1", ack).code,
      0,
    );
    const frozen = packed.run(
      shell,
      ["freeze", packed.bases, "base-v1", NAMESPACE, EXTENSION],
      "base-v1",
    );
    assert.equal(frozen.code, 0, frozen.err);
    const rows = lines(readFileSync(join(packed.root(), MARKER), "utf8"));
    assert.equal(rows[5], "install=packed");
    assert.equal(rows.length, 6);
    assert.equal(existsSync(join(packed.root(), "Default/Extensions")), true);
  });
}
