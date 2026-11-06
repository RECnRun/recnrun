import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALICE,
  EX_DATAERR,
  NAMESPACE,
  announce,
  lab,
  presence,
  readRegistry,
  run,
  shells,
} from "./lab.mjs";

// The "roots" map of registry.json (roots.sh): every root id of the record and its path.
for (const shell of shells) {
  await test(`${shell}: maps every root of the record to its path, in the order of ids`, (context) => {
    const { home, rootA, rootB, out, record } = lab(context);
    const rootC = join(home, "never created");
    const blocks = [`${rootC}\nroot=r10`, `${rootB}\nroot=r2`, `${rootA}\nroot=r1`];
    writeFileSync(record, blocks.map((block) => `downloadsRoot=${block}\n`).join("\n"));
    announce(rootA, presence(ALICE));
    assert.deepEqual(run(shell, [record, NAMESPACE, out]), { code: 0, stderr: "" });
    const { roots } = readRegistry(out);
    assert.deepEqual(Object.entries(roots), [
      ["r1", rootA],
      ["r2", rootB],
      ["r10", rootC],
    ]);
  });

  await test(`${shell}: refuses a root path the registry cannot carry, and rewrites nothing`, (context) => {
    const { rootA, rootB, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    announce(rootA, presence(ALICE));
    assert.equal(run(shell, [record, NAMESPACE, out]).code, 0);
    const registry = readFileSync(join(out, "registry.json"), "utf8");
    for (const path of [`${rootB}/`, `${rootB}/./x`, `${rootB}//x`, "/"]) {
      const text = `downloadsRoot=${rootA}\nroot=r1\n\ndownloadsRoot=${path}\n`;
      writeFileSync(record, text);
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, EX_DATAERR, `${path}: ${result.stderr}`);
      assert.match(result.stderr, /downloadsRoot/, path);
      assert.equal(readFileSync(record, "utf8"), text, `${path}: the record is kept`);
      assert.equal(readFileSync(join(out, "registry.json"), "utf8"), registry, path);
    }
  });
}
