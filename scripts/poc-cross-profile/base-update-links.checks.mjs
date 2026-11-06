import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shells } from "./lab.mjs";
import { frozenScene } from "./base-update-lab.mjs";

const EX_REFUSED = 65;
const EX_COPY = 70;
const partials = (bases) => readdirSync(bases).filter((name) => name.includes(".partial-"));

/** A folder outside the base that a link in the base points at, with a file update must never touch. */
function outside(s) {
  const dir = join(s.home, "outside");
  mkdirSync(join(dir, "RECnRun"), { recursive: true });
  writeFileSync(join(dir, "RECnRun/keep.txt"), "kept");
  return dir;
}

for (const shell of shells) {
  await test(`${shell}: update refuses a source whose downloads folder is a link and deletes nothing outside`, (context) => {
    const { s, root, update } = frozenScene(context, shell);
    const dir = outside(s);
    rmSync(join(root, "downloads"), { recursive: true });
    symlinkSync(dir, join(root, "downloads"));
    const result = update();
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.match(result.err, /symbolic or hard link/);
    assert.equal(readFileSync(join(dir, "RECnRun/keep.txt"), "utf8"), "kept");
    assert.equal(existsSync(s.root("base-v2")), false);
    assert.deepEqual(partials(s.bases), [], "no copy was started");
  });

  await test(`${shell}: update refuses a source whose Default is a link and writes nothing outside`, (context) => {
    const { s, root, update } = frozenScene(context, shell);
    const dir = outside(s);
    renameSync(join(root, "Default"), join(dir, "Default"));
    symlinkSync(join(dir, "Default"), join(root, "Default"));
    const before = readFileSync(join(dir, "Default/Preferences"), "utf8");
    const result = update();
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.equal(readFileSync(join(dir, "Default/Preferences"), "utf8"), before);
    assert.deepEqual(partials(s.bases), []);
  });

  await test(`${shell}: update fails and removes a copy that holds a link the source gained during the copy`, (context) => {
    const { s, root, update } = frozenScene(context, shell);
    const dir = outside(s);
    const bin = join(s.home, "racing-bin");
    mkdirSync(bin);
    // The link appears after the source check and is copied as it is, so diff -r finds no difference.
    const body = `#!/bin/sh\nrm -rf "$1/downloads"\nln -s "${dir}" "$1/downloads"\ncp -R -p "$1" "$2"\n`;
    writeFileSync(join(bin, "ditto"), body);
    chmodSync(join(bin, "ditto"), 0o755);
    const result = update("base-v2", undefined, {
      PATH: `${bin}:${join(s.home, "ps-stub")}:${process.env.PATH}`,
    });
    assert.equal(result.code, EX_COPY, result.err);
    assert.equal(readFileSync(join(dir, "RECnRun/keep.txt"), "utf8"), "kept");
    assert.deepEqual(partials(s.bases), [], "the copy is removed");
    assert.equal(existsSync(s.root("base-v2")), false);
    assert.equal(existsSync(root), true);
  });
}
