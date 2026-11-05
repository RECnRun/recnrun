import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE } from "./lab.mjs";
import { EXTENSION, MARKER, baseScene, environment, installExtension } from "./base-lab.mjs";

const script = fileURLToPath(new URL("./clone.sh", import.meta.url));
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SINGLETONS = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
const CLONE_KEYS = [
  "base",
  "clone",
  "instanceId",
  "namespace",
  "extensionId",
  "role",
  "createdAt",
  "copyS",
  "physicalKiB",
  "logicalBytes",
];

/** Every path below `dir` with what it is: "d", "l:<target>", or "f:<bytes>" (latin1). */
export function snapshot(dir, prefix = "") {
  const map = new Map();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const key = `${prefix}${entry}`;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) map.set(key, `l:${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      map.set(key, "d");
      for (const [sub, value] of snapshot(path, `${key}/`)) map.set(sub, value);
    } else map.set(key, `f:${readFileSync(path).toString("latin1")}`);
  }
  return map;
}

/** The lines of a key=value file as an object, in file order. */
export function fields(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/** Puts a stub `ditto` first on PATH: `body` is its shell text; it logs each call to ditto.txt. */
function installDitto(home, body) {
  mkdirSync(join(home, "ditto-stub"), { recursive: true });
  const path = join(home, "ditto-stub/ditto");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$HOME/ditto.txt"\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A base scene with a clones folder and runs of clone.sh. */
export function cloneScene(context) {
  const s = baseScene(context);
  const clones = join(s.home, "clones");
  mkdirSync(clones);
  const dittoPath = (stub) =>
    stub ? `${join(s.home, "ditto-stub")}:${process.env.PATH}` : process.env.PATH;
  const clone = (shell, args, { ditto = false, ...extra } = {}) => {
    const vars = environment(s.home, "base-v1", extra);
    const result = spawnSync(shell, [script, ...args], {
      encoding: "utf8",
      env: { ...vars, PATH: `${join(s.home, "ps-stub")}:${dittoPath(ditto)}` },
      timeout: 120_000,
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return {
    ...s,
    clones,
    clone,
    copyTo: (shell, name = "base-v1", dest = "c1", options) =>
      clone(shell, ["create-clone", s.bases, name, clones, dest, NAMESPACE], options),
    ditto: (body) => installDitto(s.home, body),
    dittoCalls: () => {
      try {
        return readFileSync(join(s.home, "ditto.txt"), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    /** Starts the stub Chrome on the root of `name`, as a running base would be. */
    hold: (name = "base-v1") => {
      const chrome = join(s.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      const child = spawn(
        chrome,
        [`--user-data-dir=${s.root(name)}`, "--profile-directory=Default"],
        { stdio: "ignore", env: environment(s.home, name, { STUB_ALIVE: "30" }) },
      );
      s.spawned.push(child.pid);
      spawnSync("sleep", ["0.3"]);
      return child.pid;
    },
  };
}

/** A frozen base: created, given the extension and a template ack, and frozen by base.sh itself. */
export function frozenBase(s, shell, name = "base-v1") {
  assert.equal(s.create(shell, name).code, 0);
  const root = s.root(name);
  installExtension(root);
  const args = (command, ...rest) => [command, s.bases, name, ...rest];
  const acked = s.run(shell, args("template", NAMESPACE), name, { STUB_ACK: "good" });
  assert.equal(acked.code, 0, acked.err);
  const frozen = s.run(shell, args("freeze", NAMESPACE, EXTENSION), name);
  assert.equal(frozen.code, 0, frozen.err);
  return root;
}

/** The stray parts of a Chrome root: the process singleton, lock files, and content of every kind. */
export function populate(root) {
  mkdirSync(join(root, "Default/Local Storage/leveldb"), { recursive: true });
  mkdirSync(join(root, "downloads"), { recursive: true });
  writeFileSync(join(root, "Local State"), '{"profile":{}}');
  writeFileSync(join(root, "lockfile"), "");
  writeFileSync(join(root, "Default/lockfile"), "x");
  writeFileSync(join(root, "Default/Local Storage/leveldb/LOCK"), "");
  writeFileSync(
    join(root, "Default/Local Storage/leveldb/000003.log"),
    Buffer.from([0, 255, 10, 7]),
  );
  writeFileSync(join(root, "downloads/keep.txt"), "kept");
  symlinkSync("host-123", join(root, "SingletonLock"));
  symlinkSync("4242", join(root, "SingletonCookie"));
  symlinkSync("/tmp/scoped.x/SingletonSocket", join(root, "SingletonSocket"));
}

/** The snapshot of the base turned into what its clone must hold, minus `.recnrun-clone`. */
export function expectedClone(before, root, dest) {
  const expected = new Map(before);
  for (const name of [...SINGLETONS, MARKER]) expected.delete(name);
  for (const key of expected.keys()) {
    if (key.startsWith("downloads/RECnRun")) expected.delete(key);
  }
  const preferences = expected.get("Default/Preferences");
  const moved = preferences.replace(
    `"default_directory":"${root}/downloads"`,
    `"default_directory":"${dest}/downloads"`,
  );
  assert.notEqual(moved, preferences);
  expected.set("Default/Preferences", moved);
  assert.ok(expected.has("Default/Local Storage/leveldb/LOCK") && expected.has("lockfile"));
  return expected;
}

/** The fields of `.recnrun-clone`: the grammar, a v4 id, counts, and the size of the files it counts. */
export function assertMarker(marker, files, started) {
  assert.deepEqual(Object.keys(marker), CLONE_KEYS);
  assert.match(marker.instanceId, V4);
  assert.deepEqual(
    [marker.base, marker.clone, marker.namespace, marker.extensionId, marker.role],
    ["base-v1", "c1", NAMESPACE, EXTENSION, "worker"],
  );
  for (const key of ["createdAt", "copyS", "physicalKiB", "logicalBytes"]) {
    assert.match(marker[key], /^\d+$/, key);
  }
  assert.ok(Number(marker.createdAt) >= started && Number(marker.createdAt) <= started + 120);
  assert.ok(Number(marker.physicalKiB) > 0);
  const bytes = [...files.values()]
    .filter((value) => value.startsWith("f:"))
    .reduce((sum, value) => sum + value.length - 2, 0);
  assert.equal(Number(marker.logicalBytes), bytes);
}
