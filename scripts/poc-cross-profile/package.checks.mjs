import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanPackage, scanText } from "./package-scan.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const forbidden = fileURLToPath(new URL("./fixtures/forbidden/", import.meta.url));

// File, the rule it must trip, and the line the offence is on.
const OFFENCES = [
  ["jq.sh", "runtime", 4],
  ["node.sh", "runtime", 4],
  ["python.sh", "runtime", 4],
  ["perl.sh", "runtime", 4],
  ["ruby.sh", "runtime", 4],
  ["eval.sh", "runtime", 4],
  ["bash-call.sh", "runtime", 4],
  ["double-bracket.sh", "bashism", 4],
  ["array.sh", "bashism", 4],
  ["local-nameref.sh", "bashism", 4],
  ["function-keyword.sh", "bashism", 4],
  ["lowercase.sh", "bashism", 4],
  ["shebang-bash.sh", "shebang", 1],
  ["shebang-env.sh", "shebang", 1],
  ["no-shebang.sh", "shebang", 1],
];

await test("the scanner rejects each fixture for its rule at its line", () => {
  const found = scanPackage(forbidden);
  for (const [file, rule, line] of OFFENCES) {
    const hits = found.filter((hit) => hit.file === file);
    assert.ok(
      hits.some((hit) => hit.rule === rule && hit.line === line),
      `${file}: expected ${rule} at line ${line}, got ${JSON.stringify(hits)}`,
    );
    assert.equal(hits.length, 1, `${file} trips exactly one finding: ${JSON.stringify(hits)}`);
  }
  assert.equal(new Set(found.map((hit) => hit.file)).size, OFFENCES.length);
});

await test("the scanner accepts the launcher package and skips fixtures", () => {
  assert.deepEqual(scanPackage(here), []);
});

await test("the scanner ignores comments, single-quoted text, and words inside names", () => {
  const lines = [
    "#!/bin/sh",
    "# node and jq appear in this comment",
    "echo 'eval is only text'",
    "nodes=1",
    'echo "$nodes" # python in a trailing comment',
  ];
  assert.deepEqual(scanText("quiet.sh", lines.join("\n")), []);
});

await test("the scanner reports a missing root", () => {
  assert.throws(() => scanPackage(`${here}missing-root`), /missing-root/);
});
