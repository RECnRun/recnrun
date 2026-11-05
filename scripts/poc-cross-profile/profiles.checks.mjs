import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALICE, BOB, CAROL, NAMESPACE, linkAt, presence, shells } from "./lab.mjs";

const script = fileURLToPath(new URL("./profiles.sh", import.meta.url));
const EX_NOT_FOUND = 66;
const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const DECOY = "abcdefghijklmnopabcdefghijklmnoo";
const MAC_CHROME = "Library/Application Support/Google/Chrome";

function profiles(shell, args, env) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const lines = (text) => text.split("\n").filter((line) => line !== "");

/** A temporary home that stands in for the machine: HOME and the probe prefix point at it. */
function lab(context) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-profiles-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const env = (extra = {}) => ({
    HOME: home,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    ...extra,
  });
  return { home, env, record: join(home, "launcher.record") };
}
function executable(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}
function profile(root, name, files = { Preferences: "{}" }) {
  mkdirSync(join(root, name), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text);
}
function plant(root, id, boot = "55555555-5555-4555-8555-555555555555") {
  const folder = join(root, "RECnRun/poc", NAMESPACE, "peers", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "presence.json"), JSON.stringify(presence(id, { boot })));
}
const pointAt = (directory) => JSON.stringify({ download: { default_directory: directory } });
const withExtension = (directory) =>
  JSON.stringify({
    download: { default_directory: directory },
    extensions: { settings: { [EXTENSION]: { path: "x" } } },
  });

for (const shell of shells) {
  await test(`${shell}: chrome_binary takes the system app, then the one in the home`, (context) => {
    const { home, env } = lab(context);
    const app = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const mac = env({ HOME: join(home, "user") });
    assert.equal(profiles(shell, ["chrome_binary"], mac).code, EX_NOT_FOUND);
    executable(join(home, "user", app));
    assert.equal(profiles(shell, ["chrome_binary"], mac).out, `${home}/user/${app}\n`);
    executable(join(home, app));
    assert.equal(profiles(shell, ["chrome_binary"], mac).out, `${home}/${app}\n`);
  });

  await test(`${shell}: chrome_binary ignores a file that is not executable`, (context) => {
    const { home, env } = lab(context);
    const app = join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    executable(app);
    chmodSync(app, 0o644);
    const mac = env({ HOME: join(home, "user") });
    assert.equal(profiles(shell, ["chrome_binary"], mac).code, EX_NOT_FOUND);
  });

  await test(`${shell}: on Linux chrome_binary tries the PATH names, then /opt`, (context) => {
    const { home, env } = lab(context);
    const linux = env({
      RECNRUN_DISCOVERY_UNAME: "Linux",
      PATH: `/usr/local/bin:/usr/bin:${process.env.PATH}`,
    });
    assert.equal(profiles(shell, ["chrome_binary"], linux).code, EX_NOT_FOUND);
    executable(join(home, "opt/google/chrome/chrome"));
    assert.equal(
      profiles(shell, ["chrome_binary"], linux).out,
      `${home}/opt/google/chrome/chrome\n`,
    );
    executable(join(home, "usr/bin/google-chrome"));
    assert.equal(profiles(shell, ["chrome_binary"], linux).out, `${home}/usr/bin/google-chrome\n`);
    executable(join(home, "usr/local/bin/google-chrome-stable"));
    assert.equal(
      profiles(shell, ["chrome_binary"], linux).out,
      `${home}/usr/local/bin/google-chrome-stable\n`,
    );
  });

  await test(`${shell}: chrome_roots lists the macOS default, then the record's, once each`, (context) => {
    const { home, env, record } = lab(context);
    assert.deepEqual(lines(profiles(shell, ["chrome_roots", record], env()).out), []);
    mkdirSync(join(home, MAC_CHROME), { recursive: true });
    mkdirSync(join(home, "Other Chrome"));
    writeFileSync(
      record,
      [
        `userDataDir=${home}/Other Chrome`,
        "",
        `userDataDir=${home}/${MAC_CHROME}`,
        "",
        `userDataDir=${home}/missing`,
        "userDataDir=relative",
        "",
      ].join("\n"),
    );
    const result = profiles(shell, ["chrome_roots", record], env());
    assert.equal(result.code, 0);
    assert.deepEqual(lines(result.out), [`${home}/${MAC_CHROME}`, `${home}/Other Chrome`]);
  });

  await test(`${shell}: chrome_roots without the OS default names only the record's`, (context) => {
    const { home, env, record } = lab(context);
    mkdirSync(join(home, "Only"));
    writeFileSync(record, `userDataDir=${home}/Only\n`);
    assert.deepEqual(lines(profiles(shell, ["chrome_roots", record], env()).out), [`${home}/Only`]);
  });

  await test(`${shell}: on Linux chrome_roots starts at XDG_CONFIG_HOME or ~/.config`, (context) => {
    const { home, env, record } = lab(context);
    const linux = { RECNRUN_DISCOVERY_UNAME: "Linux" };
    mkdirSync(join(home, ".config/google-chrome"), { recursive: true });
    assert.deepEqual(lines(profiles(shell, ["chrome_roots", record], env(linux)).out), [
      `${home}/.config/google-chrome`,
    ]);
    mkdirSync(join(home, "cfg/google-chrome"), { recursive: true });
    const moved = profiles(
      shell,
      ["chrome_roots", record],
      env({ ...linux, XDG_CONFIG_HOME: join(home, "cfg") }),
    );
    assert.deepEqual(lines(moved.out), [`${home}/cfg/google-chrome`]);
  });

  await test(`${shell}: profiles_in_root lists directory names, Default first, then sorted`, (context) => {
    const { home, env } = lab(context);
    const root = join(home, "Chrome");
    for (const name of ["Profile 2", "Profile 10", "Default", "System Profile", "Guest Profile"])
      profile(root, name);
    profile(root, "Empty", {});
    profile(root, "Linked", {});
    writeFileSync(join(home, "real-preferences"), "{}");
    symlinkSync(join(home, "real-preferences"), join(root, "Linked/Preferences"));
    writeFileSync(join(root, "Local State"), "{}");
    const result = profiles(shell, ["profiles_in_root", root], env());
    assert.equal(result.code, 0);
    assert.deepEqual(lines(result.out), ["Default", "Profile 10", "Profile 2"]);
  });

  await test(`${shell}: profiles_in_root without a Default still lists the others`, (context) => {
    const { home, env } = lab(context);
    profile(join(home, "Chrome"), "Profile 1");
    const result = profiles(shell, ["profiles_in_root", join(home, "Chrome")], env());
    assert.deepEqual(lines(result.out), ["Profile 1"]);
  });

  await test(`${shell}: extension_in_profile tells packed, unpacked, absent, uninstalled, and a decoy`, (context) => {
    const { home, env } = lab(context);
    const root = join(home, "Chrome");
    const call = (name, id = EXTENSION) =>
      profiles(shell, ["extension_in_profile", root, name, id], env());
    profile(root, "Packed", { Preferences: "{}" });
    mkdirSync(join(root, "Packed/Extensions", EXTENSION, "1.0_0"), { recursive: true });
    writeFileSync(join(root, "Packed/Extensions", EXTENSION, "1.0_0/manifest.json"), "{}");
    profile(root, "Unpacked", {
      Preferences: "{}",
      "Secure Preferences": `{"extensions":{"settings":{"${EXTENSION}":{"path":"/x"}}}}`,
    });
    profile(root, "InPreferences", {
      Preferences: `{"extensions":{"settings":{"${EXTENSION}":{"state":1}}}}`,
    });
    // Chrome leaves an empty settings entry behind when the extension is uninstalled (E8).
    profile(root, "Uninstalled", {
      Preferences: `{"extensions":{"settings":{"${EXTENSION}":{}}},"protection":{"macs":{"extensions":{"settings":{"${EXTENSION}":"ABCDEF"}}}}}`,
    });
    profile(root, "Absent");
    profile(root, "Decoy", {
      Preferences: "{}",
      "Secure Preferences": `{"extensions":{"settings":{"${DECOY}":{"path":"/x"},"x${EXTENSION}":{"path":"/x"}}}}`,
    });
    profile(root, "EmptyFolder");
    mkdirSync(join(root, "EmptyFolder/Extensions", EXTENSION, "1.0_0"), { recursive: true });
    assert.deepEqual([call("Packed").code, call("Packed").out], [0, "packed\n"]);
    assert.deepEqual([call("Unpacked").code, call("Unpacked").out], [0, "unpacked\n"]);
    assert.equal(call("InPreferences").out, "unpacked\n");
    for (const name of ["Absent", "Decoy", "EmptyFolder", "Missing", "Uninstalled"])
      assert.deepEqual([call(name).code, call(name).out], [1, ""], name);
    assert.equal(call("Decoy", DECOY).out, "unpacked\n");
  });

  await test(`${shell}: bind_profiles binds distinct roots, flags shared ones, and leaves the rest`, (context) => {
    const { home, env, record } = lab(context);
    const rootA = join(home, "ChromeA");
    const rootB = join(home, MAC_CHROME);
    const dl = (name) => join(home, name);
    writeFileSync(record, `userDataDir=${rootA}\n`);
    profile(rootA, "Default", { Preferences: withExtension(dl("DlA")) });
    profile(rootA, "Profile 2", { Preferences: withExtension(dl("DlS")) });
    profile(rootA, "Profile 3", { Preferences: withExtension(dl("DlS")) });
    profile(rootA, "Profile 4", { Preferences: withExtension(dl("DlNone")) });
    profile(rootA, "Profile 5", { Preferences: pointAt(dl("DlOther")) });
    profile(rootB, "Default", { Preferences: withExtension(dl("DlB")) });
    plant(dl("DlA"), ALICE);
    plant(dl("DlB"), BOB);
    plant(dl("DlS"), CAROL);
    plant(dl("DlS"), "44444444-4444-4444-8444-444444444444");
    plant(dl("DlOther"), "66666666-6666-4666-8666-666666666666");
    const result = profiles(shell, ["bind_profiles", record, NAMESPACE, EXTENSION], env());
    assert.equal(result.code, 0, result.err);
    const rows = [
      [BOB, rootB, "Default", dl("DlB"), "distinct"],
      [ALICE, rootA, "Default", dl("DlA"), "distinct"],
      ["-", rootA, "Profile 2", dl("DlS"), "shared"],
      ["-", rootA, "Profile 3", dl("DlS"), "shared"],
      ["-", rootA, "Profile 4", "-", "unbound"],
    ];
    assert.deepEqual(
      lines(result.out),
      rows.map((fields) => fields.join("\t")),
    );
  });

  await test(`${shell}: bind_profiles counts a presence only when it names its folder's profile`, (context) => {
    const { home, env, record } = lab(context);
    const root = join(home, "Chrome");
    const dl = (name) => join(home, name);
    writeFileSync(record, `userDataDir=${root}\n`);
    profile(root, "Default", { Preferences: withExtension(dl("DlA")) });
    profile(root, "Profile 2", { Preferences: withExtension(dl("DlB")) });
    plant(dl("DlA"), ALICE);
    plant(dl("DlA"), BOB);
    // A second presence that names another profile than its folder does not make the root shared.
    const forged = join(dl("DlA"), "RECnRun/poc", NAMESPACE, "peers", BOB, "presence.json");
    writeFileSync(forged, JSON.stringify(presence(CAROL)));
    plant(dl("DlB"), CAROL);
    writeFileSync(
      join(dl("DlB"), "RECnRun/poc", NAMESPACE, "peers", CAROL, "presence.json"),
      "not a presence",
    );
    const result = profiles(shell, ["bind_profiles", record, NAMESPACE, EXTENSION], env());
    assert.deepEqual(lines(result.out), [
      `${ALICE}\t${root}\tDefault\t${dl("DlA")}\tdistinct`,
      `-\t${root}\tProfile 2\t-\tunbound`,
    ]);
  });

  await test(`${shell}: bind_profiles takes only a presence folder that is a uuid`, (context) => {
    const { home, env, record } = lab(context);
    const root = join(home, "Chrome");
    writeFileSync(record, `userDataDir=${root}\n`);
    profile(root, "Default", { Preferences: withExtension(join(home, "Dl")) });
    plant(join(home, "Dl"), "not-a-uuid");
    const result = profiles(shell, ["bind_profiles", record, NAMESPACE, EXTENSION], env());
    assert.deepEqual(lines(result.out), [`-\t${root}\tDefault\t-\tunbound`]);
  });

  for (const [depth, part] of ["RECnRun", "poc", NAMESPACE, "peers", ALICE].entries()) {
    await test(`${shell}: bind_profiles leaves a profile unbound when ${part} is a link`, (context) => {
      const { home, env, record } = lab(context);
      const root = join(home, "Chrome");
      writeFileSync(record, `userDataDir=${root}\n`);
      profile(root, "Default", { Preferences: withExtension(join(home, "Dl")) });
      plant(join(home, "Real"), ALICE);
      linkAt(
        join(home, "Dl"),
        join(home, "Real"),
        ["RECnRun", "poc", NAMESPACE, "peers", ALICE],
        depth,
      );
      const result = profiles(shell, ["bind_profiles", record, NAMESPACE, EXTENSION], env());
      assert.deepEqual(lines(result.out), [`-\t${root}\tDefault\t-\tunbound`]);
    });
  }

  await test(`${shell}: a wrong call exits 64`, (context) => {
    const { env } = lab(context);
    assert.equal(profiles(shell, [], env()).code, 64);
    assert.equal(profiles(shell, ["rm"], env()).code, 64);
    assert.equal(profiles(shell, ["profiles_in_root"], env()).code, 64);
    assert.equal(profiles(shell, ["extension_in_profile", "/r", "Default", "bad"], env()).code, 64);
    assert.equal(profiles(shell, ["bind_profiles", "/rec", "Bad_NS", EXTENSION], env()).code, 64);
  });
}
