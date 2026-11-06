import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { openScene } from "./clone-open-lab.mjs";

const OPERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const argvOf = (s) => readFileSync(join(s.home, "argv.txt"), "utf8").split("\n").slice(0, -1);

for (const shell of shells) {
  await test(`${shell}: open-clone takes the operation id it is given, puts it in the URL, and checks the ack for it`, (context) => {
    const s = openScene(context, shell);
    const result = s.open([s.clones, "c1", s.record, NAMESPACE, "headed", OPERATION], {
      STUB_CLONE: "good",
    });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, new RegExp(`^operationId=${OPERATION}$`, "m"));
    assert.match(argvOf(s).at(-1), new RegExp(`&operation=${OPERATION}&`));
    assert.match(s.marker(), new RegExp(`^operationId=${OPERATION}$`, "m"));
  });

  await test(`${shell}: open-clone ignores an ack that answers another operation than the one given`, (context) => {
    const s = openScene(context, shell);
    const result = s.open([s.clones, "c1", s.record, NAMESPACE, "headed", OPERATION], {
      RECNRUN_OPEN_TIMEOUT_S: "1",
      STUB_CLONE: "good",
      STUB_BODY_OPERATION: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    assert.equal(result.code, 69, result.err);
    assert.equal(s.recordText().includes("role=worker"), false);
  });

  await test(`${shell}: open-clone refuses an operation id that is no lowercase v4 uuid before any launch`, (context) => {
    const s = openScene(context, shell);
    const before = s.launches();
    for (const bad of [OPERATION.toUpperCase(), "nope", "", `${OPERATION}x`, "--evil"]) {
      const result = s.open([s.clones, "c1", s.record, NAMESPACE, "headed", bad]);
      assert.equal(result.code, 65, `${bad}: ${result.err}`);
    }
    assert.equal(s.launches(), before);
  });

  const loose = [
    { title: "wrapped in bytes that are no JSON", extra: { STUB_PRE: "junk " } },
    { title: "followed by a trailing byte", extra: { STUB_POST: "\n" } },
    { title: "with an empty identity", extra: { STUB_IDENT: '"identity":{}' } },
    {
      title: "with an identity of a short key",
      extra: {
        STUB_IDENT: `"identity":{"key":"B","signedAt":1,"signature":"${"S".repeat(86)}"}`,
      },
    },
  ];
  for (const { title, extra } of loose) {
    await test(`${shell}: a clone ack ${title} registers nothing`, (context) => {
      const s = openScene(context, shell);
      const result = s.open(undefined, {
        RECNRUN_OPEN_TIMEOUT_S: "1",
        STUB_CLONE: "good",
        ...extra,
      });
      assert.equal(result.code, 69, result.err);
      assert.equal(s.recordText().includes("role=worker"), false);
    });
  }

  const bytes = [
    ["a NUL byte", "\0"],
    ["a byte over 126", "\u0080"],
    ["a carriage return", "\r"],
  ];
  for (const [title, junk] of bytes) {
    await test(`${shell}: a marker with ${title} in a value is no marker for list-clones, open-clone, or create-clone`, (context) => {
      const s = openScene(context, shell);
      const clone = join(s.root, ".recnrun-clone");
      writeFileSync(
        clone,
        readFileSync(clone, "latin1").replace("role=worker", `role=worker${junk}`),
        "latin1",
      );
      assert.equal(s.clone(shell, ["list-clones", s.clones]).out, "", "not listed");
      const opened = s.open();
      assert.equal(opened.code, 65, opened.err);
      const base = join(s.bases, "base-v1", ".recnrun-base");
      writeFileSync(
        base,
        readFileSync(base, "latin1").replace("install=unpacked", `install=unpacked${junk}`),
        "latin1",
      );
      const made = s.copyTo(shell, "base-v1", "c2");
      assert.equal(made.code, 65, made.err);
    });
  }
}
