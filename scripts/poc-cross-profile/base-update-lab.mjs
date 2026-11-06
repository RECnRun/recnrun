import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAMESPACE } from "./lab.mjs";
import { EXTENSION, baseScene, installExtension } from "./base-lab.mjs";

const SINGLETONS = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/** Fills base-v1 with the stray parts of a used root. */
function useRoot(root) {
  mkdirSync(join(root, "Default/Local Storage/leveldb"), { recursive: true });
  mkdirSync(join(root, "downloads/RECnRun/poc"), { recursive: true });
  writeFileSync(join(root, "Local State"), '{"profile":{}}');
  writeFileSync(join(root, "Default/Local Storage/leveldb/LOCK"), "");
  writeFileSync(join(root, "downloads/keep.txt"), "kept");
  writeFileSync(join(root, "downloads/RECnRun/poc/x.json"), "{}");
  for (const name of SINGLETONS) symlinkSync("host-123", join(root, name));
}

/** A clones folder that holds one clone. */
function oneClone(clones) {
  mkdirSync(join(clones, "c1/Default"), { recursive: true });
  writeFileSync(join(clones, "c1/Default/Preferences"), "{}");
  writeFileSync(join(clones, "c1/.recnrun-clone"), "base=base-v1\n");
}

/** A frozen base-v1 with the stray parts of a used root, and a clones folder that holds one clone. */
export function frozenScene(context, shell) {
  const s = baseScene(context);
  assert.equal(s.create(shell).code, 0);
  const root = s.root();
  const build = installExtension(root, { unpacked: true });
  useRoot(root);
  const ack = { STUB_ACK: "good" };
  const template = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", ack);
  assert.equal(template.code, 0, template.err);
  const freeze = s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
  assert.equal(freeze.code, 0, freeze.err);
  const clones = join(s.home, "clones");
  oneClone(clones);
  const update = (to = "base-v2", ns = NAMESPACE, extra = {}) =>
    s.run(shell, ["update", s.bases, "base-v1", to, ns], to, extra);
  return { s, root, build, clones, update };
}
