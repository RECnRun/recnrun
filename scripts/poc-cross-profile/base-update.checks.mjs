import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import {
  EXTENSION,
  MARKER,
  baseScene,
  contents,
  environment,
  installExtension,
  listing,
} from "./base-lab.mjs";

const EX_USAGE = 64;
const EX_REFUSED = 65;
const EX_COPY = 70;
const lines = (text) => text.split("\n").filter(Boolean);
const SINGLETONS = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/** A frozen base-v1 with the stray parts of a used root, and a clones folder that holds one clone. */
function frozenScene(context, shell) {
  const s = baseScene(context);
  assert.equal(s.create(shell).code, 0);
  const root = s.root();
  const build = installExtension(root, { unpacked: true });
  mkdirSync(join(root, "Default/Local Storage/leveldb"), { recursive: true });
  mkdirSync(join(root, "downloads/RECnRun/poc"), { recursive: true });
  writeFileSync(join(root, "Local State"), '{"profile":{}}');
  writeFileSync(join(root, "Default/Local Storage/leveldb/LOCK"), "");
  writeFileSync(join(root, "downloads/keep.txt"), "kept");
  writeFileSync(join(root, "downloads/RECnRun/poc/x.json"), "{}");
  for (const name of SINGLETONS) symlinkSync("host-123", join(root, name));
  const template = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", {
    STUB_ACK: "good",
  });
  assert.equal(template.code, 0, template.err);
  const freeze = s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
  assert.equal(freeze.code, 0, freeze.err);
  const clones = join(s.home, "clones");
  mkdirSync(join(clones, "c1/Default"), { recursive: true });
  writeFileSync(join(clones, "c1/Default/Preferences"), "{}");
  writeFileSync(join(clones, "c1/.recnrun-clone"), "base=base-v1\n");
  const update = (to = "base-v2", ns = NAMESPACE, extra = {}) =>
    s.run(shell, ["update", s.bases, "base-v1", to, ns], to, extra);
  return { s, root, build, clones, update };
}

for (const shell of shells) {
  await test(`${shell}: update copies a frozen base to a new root, opens it for the owner, and leaves old clones alone`, (context) => {
    const { s, root, build, clones, update } = frozenScene(context, shell);
    const before = { base: listing(root), clones: listing(clones), files: contents(root) };
    const launched = s.launchCount();
    const result = update();
    assert.equal(result.code, 0, result.err);
    const dest = s.root("base-v2");
    const out = lines(result.out);
    assert.equal(out[0], `root=${dest}`);
    assert.match(out[1] ?? "", /^copyS=\d+$/);
    assert.equal(out.length, 2);
    assert.deepEqual(listing(root), before.base, "the old base is untouched");
    assert.deepEqual(listing(clones), before.clones, "the old clones are untouched");
    assert.deepEqual(
      readdirSync(s.bases).sort(),
      ["base-v1", "base-v2"],
      "no partial copy is left",
    );
    const expected = new Map(before.files);
    for (const name of [...SINGLETONS, MARKER]) expected.delete(name);
    for (const name of expected.keys()) {
      if (name.startsWith("downloads/RECnRun")) expected.delete(name);
    }
    const preferences = String(expected.get("Default/Preferences"));
    const moved = preferences.replace(`${root}/downloads`, `${dest}/downloads`);
    assert.notEqual(moved, preferences);
    expected.set("Default/Preferences", moved);
    assert.deepEqual(contents(dest), expected);
    assert.equal(
      preferences.includes(build),
      true,
      "the unpacked path stays for the owner to load",
    );
    for (let tries = 0; tries < 100 && s.launchCount() <= launched; tries += 1) {
      spawnSync("sleep", ["0.05"]); // the stub Chrome runs in the background
    }
    assert.deepEqual(s.argv(), [
      `--user-data-dir=${dest}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "chrome://extensions/",
      "chrome://version/",
    ]);
    assert.equal(s.launchCount(), launched + 1);
  });

  await test(`${shell}: the updated base takes the template and the freeze of its own setting`, (context) => {
    const { s, root, update } = frozenScene(context, shell);
    assert.equal(update().code, 0);
    const next = s.root("base-v2");
    const args = (command, ...rest) => [command, s.bases, "base-v2", ...rest];
    const template = s.run(shell, args("template", NAMESPACE), "base-v2", { STUB_ACK: "good" });
    assert.equal(template.code, 0, template.err);
    const frozen = s.run(shell, args("freeze", NAMESPACE, EXTENSION), "base-v2");
    assert.equal(frozen.code, 0, frozen.err);
    const rows = lines(readFileSync(join(next, MARKER), "utf8"));
    assert.equal(rows[0], "setting=base-v2");
    assert.equal(rows[5], "install=unpacked");
    assert.match(rows[6] ?? "", /^unpackedPath=\//);
    assert.match(readFileSync(join(root, MARKER), "utf8"), /^setting=base-v1\n/);
  });

  await test(`${shell}: update refuses a source that is not frozen, one in use, a taken name, and a wrong call`, async (context) => {
    const { s, root, update } = frozenScene(context, shell);
    assert.equal(s.create(shell, "base-v3").code, 0);
    const loose = s.run(shell, ["update", s.bases, "base-v3", "base-v4", NAMESPACE], "base-v4");
    assert.equal(loose.code, EX_REFUSED, loose.err);
    assert.match(loose.err, /not a frozen base/);
    mkdirSync(s.root("base-v2"));
    const taken = update();
    assert.equal(taken.code, EX_REFUSED, taken.err);
    assert.match(taken.err, /exists/);
    for (const [to, ns] of [
      ["base-2", NAMESPACE],
      ["base-v5", "Bad Space"],
      ["base-v5", "other-ns"],
    ])
      assert.equal(update(to, ns).code, EX_REFUSED, `${to} ${ns}`);
    assert.equal(s.run(shell, ["update", s.bases, "base-v1", "base-v5"], "base-v5").code, EX_USAGE);
    const chrome = join(s.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    const child = spawn(chrome, [`--user-data-dir=${root}`, "--profile-directory=Default"], {
      stdio: "ignore",
      env: environment(s.home, "base-v1", { STUB_ALIVE: "30" }),
    });
    s.spawned.push(child.pid);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const held = s.launchCount();
    const busy = update("base-v6");
    assert.equal(busy.code, EX_REFUSED, busy.err);
    assert.match(busy.err, new RegExp(`${child.pid}`));
    assert.equal(existsSync(s.root("base-v6")), false);
    assert.equal(s.launchCount(), held, "no refusal started Chrome");
  });

  await test(`${shell}: a failed copy keeps its partial, publishes nothing, and starts no Chrome`, (context) => {
    const { s, update } = frozenScene(context, shell);
    const bin = join(s.home, "failing-bin");
    mkdirSync(bin);
    for (const tool of ["ditto", "cp"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const launched = s.launchCount();
    const result = update("base-v2", NAMESPACE, {
      PATH: `${bin}:${join(s.home, "ps-stub")}:${process.env.PATH}`,
    });
    assert.equal(result.code, EX_COPY, result.err);
    assert.match(result.err, /interrupted copy kept at .*\.base-v2\.partial-[0-9a-f]{16}/);
    assert.equal(existsSync(s.root("base-v2")), false);
    assert.equal(s.launchCount(), launched);
  });
}
