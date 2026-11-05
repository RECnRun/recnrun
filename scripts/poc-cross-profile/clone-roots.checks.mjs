import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALICE,
  BOB,
  NAMESPACE,
  announce,
  lab,
  presence,
  readRegistry,
  run,
  shells,
} from "./lab.mjs";
import { cloneScene, frozenBase, populate } from "./clone-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";
import { open, scene as openScene } from "./open-lab.mjs";

const EX_REFUSED = 65;
const PARTIAL = ".c1.partial-0123456789abcdef";

for (const shell of shells) {
  await test(`${shell}: open and bind refuse the partial of an interrupted copy before any launch`, (context) => {
    const s = cloneScene(context);
    const root = frozenBase(s, shell);
    populate(root);
    s.ditto('cp -R -p "$1" "$2"; exit 1');
    assert.equal(s.copyTo(shell, "base-v1", "c1", { ditto: true }).code, 70);
    const partial = s.clone(shell, ["list-clones", s.clones]).out.trim().replace("partial ", "");
    const o = openScene(context);
    const copied = open(shell, ["bind", partial, "Default", NAMESPACE], o.env());
    assert.equal(copied.code, EX_REFUSED, copied.err);
    assert.equal(existsSync(o.argv), false, "Chrome never started on the interrupted copy");
    const root2 = join(o.home, PARTIAL);
    renameSync(o.root, root2);
    const bound = open(shell, ["bind", root2, "Default", NAMESPACE], o.env());
    assert.equal(bound.code, EX_REFUSED, bound.err);
    assert.match(bound.err, /unpublished clone copy is not an executor/);
    assert.equal(existsSync(o.argv), false);
    writeFileSync(o.record, `${o.block(ALICE).replace(o.root, root2)}\n`);
    const opened = open(shell, ["open", o.record, NAMESPACE, ALICE], o.env());
    assert.equal(opened.code, EX_REFUSED, opened.err);
    assert.match(opened.err, /unpublished clone copy/);
    assert.equal(existsSync(o.argv), false);
  });

  await test(`${shell}: first-run skips the partial root of a record and says so`, (context) => {
    const s = firstRunScene(context);
    const partial = join(s.home, PARTIAL);
    renameSync(s.root, partial);
    writeFileSync(
      s.record,
      `userDataDir=${partial}\nprofileDirectory=Default\nprofileId=${ALICE}\nnamespace=lab\ndownloadsRoot=${s.home}/Downloads\n`,
    );
    const result = firstRun(
      shell,
      [s.state, s.record, "lab"],
      s.vars({ RECNRUN_OPEN_TIMEOUT_S: "2" }),
    );
    assert.equal(result.code, 66, result.err);
    assert.match(result.err, /unpublished clone copy/);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: catalog skips the Downloads root of a partial and keeps the others`, (context) => {
    const l = lab(context);
    const partial = join(l.home, "clones", PARTIAL);
    const pinned = join(partial, "downloads");
    mkdirSync(pinned, { recursive: true });
    announce(pinned, presence(ALICE));
    announce(l.rootA, presence(BOB));
    const block = (user, downloads) =>
      `userDataDir=${user}\nprofileDirectory=Default\nprofileId=${user === l.home ? BOB : ALICE}\nnamespace=${NAMESPACE}\ndownloadsRoot=${downloads}\n`;
    writeFileSync(l.record, `${block(partial, pinned)}\n${block(l.home, l.rootA)}`);
    const result = run(shell, [l.record, NAMESPACE, l.out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /the Downloads root of an unpublished clone copy/);
    assert.deepEqual(Object.keys(readRegistry(l.out).peers), [BOB]);
  });
}
