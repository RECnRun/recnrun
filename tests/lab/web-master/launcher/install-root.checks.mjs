import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXTENSION } from "../../../../scripts/poc-cross-profile/base-lab.mjs";
import { installScene } from "../../../../scripts/poc-cross-profile/install-lab.mjs";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";

const base = fileURLToPath(
  new URL("../../../../scripts/poc-cross-profile/base.sh", import.meta.url),
);
const EX_USAGE = 64;
const EX_FAILED = 70;
const EX_CANTCREAT = 73;

function seed(shell, root) {
  const out = spawnSync(shell, [base, "seed-root", join(root, "chrome"), join(root, "downloads")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  return { code: out.status, err: out.stderr };
}

/** A lab root the launcher would make: the owner marker, the seeded profile, and a copied extension. */
function labRoot(shell, s, { marker = true } = {}) {
  const root = join(s.home, "lab/roots/w1");
  mkdirSync(join(root, "ext"), { recursive: true });
  if (marker) writeFileSync(join(root, ".recnrun-lab-root"), "w1\n");
  writeFileSync(join(root, "ext/manifest.json"), "{}");
  assert.equal(seed(shell, root).code, 0);
  return root;
}

for (const shell of shells) {
  await test(`${shell}: seed-root pins the profile's downloads and never overwrites`, (context) => {
    const s = installScene(context);
    const root = join(s.home, "fresh");
    mkdirSync(root);
    assert.equal(seed(shell, root).code, 0);
    const prefs = readFileSync(join(root, "chrome/Default/Preferences"), "utf8");
    assert.equal(
      prefs,
      `{"download":{"default_directory":"${root}/downloads","directory_upgrade":true,"prompt_for_download":false}}`,
    );
    assert.ok(existsSync(join(root, "downloads")));
    assert.equal(seed(shell, root).code, EX_CANTCREAT);
    assert.equal(seed(shell, join(s.home, "odd dir")).code, EX_USAGE);
  });

  await test(`${shell}: install-root loads the root's extension headless and waits for the self-test`, (context) => {
    const s = installScene(context);
    const root = labRoot(shell, s);
    const selftest = join(root, "downloads/provisioned-1.json");
    const ok = s.run(shell, ["install-root", root, "provisioned-1.json"], {
      STUB_SELFTEST: selftest,
    });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, new RegExp(`^extensionId=${EXTENSION}\ninstallS=\\d+\n$`));
    const argv = s.argv();
    for (const flag of [
      `--user-data-dir=${root}/chrome`,
      "--headless=new",
      "--remote-debugging-pipe",
    ]) {
      assert.ok(argv.includes(flag), `${flag} in ${argv.join(" ")}`);
    }
    assert.ok(!argv.includes("--no-sandbox"));
    assert.equal(s.messages()[0].params.path, join(root, "ext"));
  });

  await test(`${shell}: install-root adds --no-sandbox only in the test container`, (context) => {
    const s = installScene(context);
    const root = labRoot(shell, s);
    const ok = s.run(shell, ["install-root", root], { RECNRUN_TEST_CONTAINER: "1" });
    assert.equal(ok.code, 0, ok.err);
    assert.ok(s.argv().includes("--no-sandbox"));
  });

  await test(`${shell}: install-root fails when the self-test never lands`, (context) => {
    const s = installScene(context);
    const root = labRoot(shell, s);
    const late = s.run(shell, ["install-root", root, "provisioned-1.json"]);
    assert.equal(late.code, EX_FAILED, late.err);
    assert.match(late.err, /provisioned-1\.json/);
  });

  await test(`${shell}: install-root refuses a root it does not own`, (context) => {
    const s = installScene(context);
    const root = labRoot(shell, s, { marker: false });
    assert.equal(s.run(shell, ["install-root", root]).code, EX_USAGE);
    writeFileSync(join(root, ".recnrun-lab-root"), "w1\n");
    assert.equal(s.run(shell, ["install-root", root, "../escape.json"]).code, EX_USAGE);
    const personal = join(s.home, "Library/Application Support/Google/Chrome");
    assert.equal(s.run(shell, ["install-root", personal]).code, EX_USAGE);
    assert.deepEqual(s.launches(), []);
  });
}
