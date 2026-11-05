import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { EXTENSION, MARKER } from "./base-lab.mjs";
import {
  SINGLETONS,
  assertMarker,
  cloneScene,
  expectedClone,
  fields,
  frozenBase,
  populate,
  snapshot,
} from "./clone-lab.mjs";

const EX_REFUSED = 65;
const EX_COPY = 70;
const EX_EXISTS = 73;
const EX_HELD = 75;
const partials = (clones) => readdirSync(clones).filter((name) => /^\..+\.partial-/.test(name));
const lines = (text) => text.split("\n").filter(Boolean);

/** A frozen base with the process singleton, locks, and content planted; returns the scene and root. */
function ready(context, shell) {
  const s = cloneScene(context);
  const root = frozenBase(s, shell);
  populate(root);
  return { s, root };
}
const emptyClones = (s) => assert.deepEqual(readdirSync(s.clones), [], "nothing was created");

for (const shell of shells) {
  await test(`${shell}: create-clone refuses a base that is not frozen or whose marker is not the freeze grammar`, (context) => {
    const s = cloneScene(context);
    assert.equal(s.copyTo(shell).code, EX_REFUSED, "no base at all");
    mkdirSync(s.root(), { recursive: true });
    const bare = s.copyTo(shell);
    assert.equal(bare.code, EX_REFUSED, bare.err);
    assert.match(bare.err, /not a frozen base/);
    const good = [
      "setting=base-v1",
      `extensionId=${EXTENSION}`,
      "profileId=11111111-1111-4111-8111-111111111111",
      `namespace=${NAMESPACE}`,
      "frozenAt=1",
      "install=unpacked",
    ];
    const bad = [
      good.slice(0, 5),
      [...good, "extra=1"],
      [good[1], good[0], ...good.slice(2)],
      ["setting=base-v2", ...good.slice(1)],
      [good[0], "extensionId=short", ...good.slice(2)],
      [...good.slice(0, 2), "profileId=nope", ...good.slice(3)],
      [...good.slice(0, 5), "install=other"],
      [...good.slice(0, 4), "frozenAt=1x", good[5]],
    ];
    for (const rows of bad) {
      writeFileSync(join(s.root(), MARKER), `${rows.join("\n")}\n`);
      const result = s.copyTo(shell);
      assert.equal(result.code, EX_REFUSED, `${rows.join(" | ")}: ${result.err}`);
      assert.match(result.err, /freeze grammar|six lines/);
    }
    writeFileSync(join(s.root(), MARKER), `${good.join("\n")}\n`);
    mkdirSync(join(s.root(), "Default"));
    assert.equal(s.copyTo(shell).code, EX_COPY, "a frozen base without Preferences fails the copy");
    assert.equal(partials(s.clones).length, 1, "and the partial stays");
  });

  await test(`${shell}: create-clone refuses another namespace, bad names, and bad directories`, (context) => {
    const { s } = ready(context, shell);
    const other = s.clone(shell, ["create-clone", s.bases, "base-v1", s.clones, "c1", "other"]);
    assert.equal(other.code, EX_REFUSED, other.err);
    assert.match(other.err, /frozen for namespace lab-1/);
    const call = (...args) => s.clone(shell, ["create-clone", ...args]);
    for (const bad of ["", ".x", "-x", "a b", "a_b", "a.b", "a".repeat(33), "a/b"]) {
      assert.equal(call(s.bases, "base-v1", s.clones, bad, NAMESPACE).code, EX_REFUSED, `[${bad}]`);
    }
    for (const bad of ["base-1", "base-v", "base-v1x", "Base-v1", "../base-v1"]) {
      assert.equal(call(s.bases, bad, s.clones, "c1", NAMESPACE).code, EX_REFUSED, bad);
    }
    assert.equal(call(s.bases, "base-v1", s.clones, "c1", "Bad Space").code, EX_REFUSED);
    mkdirSync(join(s.home, "odd dir"));
    symlinkSync(s.clones, join(s.home, "linked"));
    for (const dir of [
      "relative",
      join(s.home, "missing"),
      join(s.home, "odd dir"),
      join(s.home, "linked"),
    ]) {
      assert.equal(call(s.bases, "base-v1", dir, "c1", NAMESPACE).code, EX_REFUSED, dir);
    }
    mkdirSync(join(s.root(), "inside"));
    assert.equal(
      call(s.bases, "base-v1", join(s.root(), "inside"), "c1", NAMESPACE).code,
      EX_REFUSED,
    );
    assert.equal(call(s.bases, "base-v1", s.clones, "c1").code, 64);
    emptyClones(s);
  });

  await test(`${shell}: create-clone refuses 75 while a process names the base root`, (context) => {
    const { s } = ready(context, shell);
    const pid = s.hold();
    const result = s.copyTo(shell);
    assert.equal(result.code, EX_HELD, result.err);
    assert.match(result.err, new RegExp(`names the base root.*${pid}`));
    emptyClones(s);
  });

  await test(`${shell}: create-clone refuses 73 an occupied destination of any kind and leaves it as it was`, (context) => {
    const { s } = ready(context, shell);
    writeFileSync(join(s.clones, "file"), "mine");
    mkdirSync(join(s.clones, "dir"));
    writeFileSync(join(s.clones, "dir/inner.txt"), "inner");
    symlinkSync(join(s.home, "nowhere"), join(s.clones, "dangling"));
    symlinkSync(s.clones, join(s.clones, "link"));
    const before = snapshot(s.clones);
    for (const name of ["file", "dir", "dangling", "link"]) {
      const result = s.copyTo(shell, "base-v1", name);
      assert.equal(result.code, EX_EXISTS, `${name}: ${result.err}`);
    }
    assert.deepEqual(snapshot(s.clones), before);
  });

  await test(`${shell}: create-clone refuses 65 a base with a symbolic or hard link outside the Singleton markers`, (context) => {
    const { s, root } = ready(context, shell);
    const cases = [
      () => symlinkSync("Local State", join(root, "Default/alias")),
      () => linkSync(join(root, "Local State"), join(root, "Default/twin")),
      () => symlinkSync("x", join(root, "Default/SingletonLock")),
    ];
    for (const plant of cases) {
      plant();
      const result = s.copyTo(shell);
      assert.equal(result.code, EX_REFUSED, result.err);
      assert.match(result.err, /symbolic or hard link/);
      emptyClones(s);
      for (const name of ["alias", "twin", "SingletonLock"]) {
        rmSync(join(root, "Default", name), { force: true });
      }
    }
    assert.equal(s.copyTo(shell).code, 0, "the base without them copies");
  });

  await test(`${shell}: create-clone copies the whole root, changing only what a clone must change`, (context) => {
    const { s, root } = ready(context, shell);
    const before = snapshot(root);
    assert.ok(before.has("downloads/RECnRun"), "the fixture base holds a rendezvous");
    for (const name of SINGLETONS) assert.ok(before.has(name));
    const started = Math.floor(Date.now() / 1000);
    const result = s.copyTo(shell);
    assert.equal(result.code, 0, result.err);
    const dest = join(s.clones, "c1");
    const actual = snapshot(dest);
    const created = actual.get(".recnrun-clone");
    actual.delete(".recnrun-clone");
    assert.deepEqual(actual, expectedClone(before, root, dest));
    const marker = fields(created.slice(2));
    assertMarker(marker, actual, started);
    assert.deepEqual(lines(result.out), [
      `clone=${dest}`,
      `instanceId=${marker.instanceId}`,
      `copyS=${marker.copyS}`,
      `physicalKiB=${marker.physicalKiB}`,
      `logicalBytes=${marker.logicalBytes}`,
    ]);
    assert.deepEqual(snapshot(root), before, "the base is untouched");
    assert.deepEqual(partials(s.clones), []);
  });

  await test(`${shell}: create-clone gives each clone its own v4 instance id and list-clones lists them in order`, (context) => {
    const { s } = ready(context, shell);
    assert.equal(s.copyTo(shell, "base-v1", "B").code, 0);
    assert.equal(s.copyTo(shell, "base-v1", "A").code, 0);
    const marker = (name) => fields(readFileSync(join(s.clones, name, ".recnrun-clone"), "utf8"));
    assert.notEqual(marker("A").instanceId, marker("B").instanceId);
    mkdirSync(join(s.clones, "empty"));
    mkdirSync(join(s.clones, "broken"));
    writeFileSync(join(s.clones, "broken/.recnrun-clone"), "base=base-v1\n");
    const listed = s.clone(shell, ["list-clones", s.clones]);
    assert.equal(listed.code, 0, listed.err);
    assert.deepEqual(lines(listed.out), [
      `A ${marker("A").instanceId} base-v1 ${marker("A").createdAt}`,
      `B ${marker("B").instanceId} base-v1 ${marker("B").createdAt}`,
    ]);
    assert.equal(s.clone(shell, ["list-clones", s.clones]).out, listed.out, "a stable order");
  });

  await test(`${shell}: create-clone copies with ditto when it is on PATH`, (context) => {
    const { s } = ready(context, shell);
    s.ditto('cp -R -p "$1" "$2"');
    const result = s.copyTo(shell, "base-v1", "c1", { ditto: true });
    assert.equal(result.code, 0, result.err);
    const [call] = s.dittoCalls();
    assert.match(call, new RegExp(`^${s.root()} ${s.clones}/\\.c1\\.partial-[0-9a-f]{16}$`));
    assert.ok(existsSync(join(s.clones, "c1/.recnrun-clone")));
  });

  await test(`${shell}: an interrupted copy leaves the partial, publishes nothing, and discard-partial removes only it`, (context) => {
    const { s } = ready(context, shell);
    assert.equal(s.copyTo(shell, "base-v1", "kept").code, 0);
    s.ditto('cp -R -p "$1" "$2"; rm -rf "$2/downloads" "$2/Default/Local Storage"; exit 1');
    const result = s.copyTo(shell, "base-v1", "c2", { ditto: true });
    assert.equal(result.code, EX_COPY, result.err);
    const [partial] = partials(s.clones);
    assert.match(result.err, new RegExp(`interrupted copy kept at ${s.clones}/${partial}`));
    assert.equal(partials(s.clones).length, 1);
    assert.equal(existsSync(join(s.clones, "c2")), false, "nothing was published");
    const listed = lines(s.clone(shell, ["list-clones", s.clones]).out);
    assert.deepEqual(listed.slice(1), [`partial ${s.clones}/${partial}`]);
    assert.match(listed[0], /^kept /);
    const path = join(s.clones, partial);
    const refused = [
      join(s.clones, "kept"),
      join(s.clones, ".c2.partial-zz"),
      join(s.clones, ".c2.partial-0123456789ABCDEF"),
      join(s.home, partial),
      `${s.clones}/../clones/${partial}`,
      join(s.clones, "missing"),
    ];
    for (const bad of refused) {
      const result = s.clone(shell, ["discard-partial", s.clones, bad]);
      assert.equal(result.code, EX_REFUSED, `${bad}: ${result.err}`);
    }
    symlinkSync(s.root(), join(s.clones, ".l.partial-0123456789abcdef"));
    mkdirSync(join(s.clones, ".k.partial-0123456789abcdef"));
    writeFileSync(join(s.clones, ".k.partial-0123456789abcdef/.recnrun-clone"), "");
    for (const bad of [".l.partial-0123456789abcdef", ".k.partial-0123456789abcdef"]) {
      const kept = s.clone(shell, ["discard-partial", s.clones, join(s.clones, bad)]);
      assert.equal(kept.code, EX_REFUSED, kept.err);
    }
    assert.ok(existsSync(join(s.clones, "kept/.recnrun-clone")));
    assert.ok(existsSync(path) && existsSync(s.root()));
    const gone = s.clone(shell, ["discard-partial", s.clones, path]);
    assert.equal(gone.code, 0, gone.err);
    assert.equal(existsSync(path), false);
    assert.ok(
      existsSync(join(s.clones, "kept/.recnrun-clone")),
      "a published clone is never deleted",
    );
  });

  await test(`${shell}: create-clone exits 70 and keeps the partial when the copy differs or Preferences cannot be rewritten`, (context) => {
    const { s, root } = ready(context, shell);
    s.ditto('cp -R -p "$1" "$2"; rm -f "$2/Local State"');
    const short = s.copyTo(shell, "base-v1", "c1", { ditto: true });
    assert.equal(short.code, EX_COPY, short.err);
    assert.match(short.err, /differs from the base/);
    assert.equal(partials(s.clones).length, 1);
    writeFileSync(
      join(root, "Default/Preferences"),
      `{"download":{"default_directory":"${root}/downloads"},"savefile":{"default_directory":"${root}/x"}}`,
    );
    const twice = s.copyTo(shell, "base-v1", "c2");
    assert.equal(twice.code, EX_COPY, twice.err);
    assert.match(twice.err, /exactly once/);
    assert.equal(partials(s.clones).length, 2);
    assert.equal(existsSync(join(s.clones, "c2")), false);
  });
}
