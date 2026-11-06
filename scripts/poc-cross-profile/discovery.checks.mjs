import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BOB, NAMESPACE, PEER_BOOT, presence, shells } from "./lab.mjs";

const script = fileURLToPath(new URL("./discovery.sh", import.meta.url));
const OTHER_BOOT = "66666666-6666-4666-8666-666666666666";
const EX_NOT_FOUND = 66;
const hasPlutil = spawnSync("sh", ["-c", "command -v plutil"]).status === 0;
// The sed reader always runs; plutil runs where the host has it (macOS).
const readers = hasPlutil ? ["sed", "plutil"] : ["sed"];

function discovery(shell, args, env = {}) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const lines = (text) => text.split("\n").filter((line) => line !== "");

/** A temporary home, a Chrome user data folder, and a PATH whose xdg-user-dir is a stub. */
function lab(context) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-discovery-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const userData = join(home, "Chrome");
  const stubs = join(home, "stubs");
  mkdirSync(join(userData, "Default"), { recursive: true });
  mkdirSync(stubs);
  const stub = (body) => {
    writeFileSync(join(stubs, "xdg-user-dir"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(stubs, "xdg-user-dir"), 0o755);
  };
  stub("exit 1");
  const env = (extra = {}) => ({
    HOME: home,
    PATH: `${stubs}:${process.env.PATH}`,
    RECNRUN_DISCOVERY_UNAME: "Linux",
    ...extra,
  });
  return { home, userData, stub, env, record: join(home, "launcher.record") };
}

/** Publishes a presence of `boot` below <root>/RECnRun/poc/<namespace>/peers/. */
function plant(root, boot, id = BOB) {
  const folder = join(root, "RECnRun/poc", NAMESPACE, "peers", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "presence.json"), JSON.stringify(presence(id, { boot })));
  return folder;
}
function setPreferences(userData, text) {
  writeFileSync(join(userData, "Default/Preferences"), text);
}
function pointPreferencesAt(userData, directory) {
  setPreferences(userData, JSON.stringify({ download: { default_directory: directory } }));
}

// Chrome writes Preferences as one compact line, so the fixtures are inline: a formatter would
// pretty-print files and change what the sed reader is held to. Name, text, what each reader prints.
const raw = String.raw;
const PREFERENCES = [
  [
    "key absent",
    raw`{"download":{"prompt_for_download":false},"savefile":{"default_directory":"/decoy/save"}}`,
    "",
  ],
  [
    "savefile decoy only",
    raw`{"savefile":{"default_directory":"/decoy/save"},"download":{"directory_upgrade":true}}`,
    "",
  ],
  [
    "plain",
    raw`{"a":{"b":1},"download":{"directory_upgrade":true,"default_directory":"/Users/x/Dl"},"savefile":{"default_directory":"/decoy/save"}}`,
    "/Users/x/Dl",
  ],
  [
    "after the savefile decoy",
    raw`{"savefile":{"default_directory":"/decoy/save"},"download":{"default_directory":"/Users/x/Dl 2"}}`,
    "/Users/x/Dl 2",
  ],
  [
    "escaped quote, backslash, slash",
    raw`{"download":{"default_directory":"/Users/a\"b\\c\/d"}}`,
    '/Users/a"b\\c/d',
  ],
  [
    "escaped backslash before u003C",
    raw`{"download":{"default_directory":"/x\\u003Cy"}}`,
    "/x\\u003Cy",
  ],
  [
    "u003C and u003E",
    raw`{"download":{"default_directory":"/Users/\u003Cdir\u003E"}}`,
    "/Users/<dir>",
  ],
  [
    "UTF-8 as written",
    '{"download":{"default_directory":"/Users/José/Descargas"}}',
    "/Users/José/Descargas",
  ],
  [
    "UTF-8 escaped",
    raw`{"download":{"default_directory":"/Users/jos\u00e9/\u20ac\u4e2d"}}`,
    "/Users/josé/€中",
  ],
  ["relative path", raw`{"download":{"default_directory":"Downloads"}}`, ""],
  ["unterminated string", raw`{"download":{"default_directory":"/unterminated}}`, ""],
  ["newline escape", raw`{"download":{"default_directory":"/a\nb"}}`, ""],
  ["lone surrogate", raw`{"download":{"default_directory":"/a\ud800b"}}`, ""],
];

for (const shell of shells) {
  for (const reader of readers) {
    const env = reader === "sed" ? { RECNRUN_DISCOVERY_NO_PLUTIL: "1" } : {};
    for (const [fixture, text, expected] of PREFERENCES) {
      await test(`${shell}, ${reader}: Preferences ${fixture} reads ${JSON.stringify(expected)}`, (context) => {
        const { userData, env: base } = lab(context);
        setPreferences(userData, text);
        const result = discovery(shell, ["pref_download_dir", userData, "Default"], base(env));
        assert.equal(result.code, 0);
        assert.equal(result.out, expected === "" ? "" : `${expected}\n`);
      });
    }
  }

  await test(`${shell}: a missing Preferences file reads nothing`, (context) => {
    const { userData, env } = lab(context);
    const result = discovery(shell, ["pref_download_dir", userData, "Profile 9"], env());
    assert.deepEqual([result.code, result.out], [0, ""]);
  });

  await test(`${shell}: the OS default is xdg-user-dir when the tool answers`, (context) => {
    const { home, stub, env } = lab(context);
    stub(`printf '%s\\n' "$HOME/Stub Dl"`);
    const result = discovery(shell, ["os_default_download_dir"], env());
    assert.equal(result.out, `${home}/Stub Dl\n`);
  });

  await test(`${shell}: without xdg-user-dir the OS default is XDG_DOWNLOAD_DIR with $HOME expanded`, (context) => {
    const { home, env } = lab(context);
    mkdirSync(join(home, ".config"));
    writeFileSync(
      join(home, ".config/user-dirs.dirs"),
      '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Descargas"\n',
    );
    assert.equal(discovery(shell, ["os_default_download_dir"], env()).out, `${home}/Descargas\n`);
  });

  await test(`${shell}: XDG_CONFIG_HOME moves user-dirs.dirs`, (context) => {
    const { home, env } = lab(context);
    mkdirSync(join(home, "cfg"));
    writeFileSync(join(home, "cfg/user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="/mnt/data/dl"\n');
    const result = discovery(
      shell,
      ["os_default_download_dir"],
      env({ XDG_CONFIG_HOME: join(home, "cfg") }),
    );
    assert.equal(result.out, "/mnt/data/dl\n");
  });

  await test(`${shell}: with no tool and no file the OS default is ~/Downloads`, (context) => {
    const { home, env } = lab(context);
    assert.equal(discovery(shell, ["os_default_download_dir"], env()).out, `${home}/Downloads\n`);
  });

  await test(`${shell}: on macOS the OS default is ~/Downloads whatever Linux files exist`, (context) => {
    const { home, stub, env } = lab(context);
    stub(`printf '%s\\n' "$HOME/Stub Dl"`);
    mkdirSync(join(home, ".config"));
    writeFileSync(join(home, ".config/user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/Descargas"\n');
    const result = discovery(
      shell,
      ["os_default_download_dir"],
      env({ RECNRUN_DISCOVERY_UNAME: "Darwin" }),
    );
    assert.equal(result.out, `${home}/Downloads\n`);
  });

  await test(`${shell}: the record names its Downloads roots and nothing else`, (context) => {
    const { home, env, record } = lab(context);
    writeFileSync(
      record,
      [
        `userDataDir=${home}/Chrome`,
        "profileDirectory=Default",
        `downloadsRoot=${home}/Downloads A`,
        "root=r1",
        "",
        "downloadsRoot=relative/dir",
        "",
        `downloadsRoot=${home}/Downloads_B`,
        "",
      ].join("\n"),
    );
    const result = discovery(shell, ["record_roots", record], env());
    assert.deepEqual(lines(result.out), [`${home}/Downloads A`, `${home}/Downloads_B`]);
    assert.deepEqual(lines(discovery(shell, ["record_roots", join(home, "none")], env()).out), []);
  });

  await test(`${shell}: the bounded find reports roots, not hidden, deeper, or linked ones`, (context) => {
    const { home, env } = lab(context);
    plant(join(home, "Downloads"));
    plant(join(home, "a/b/c/Deep Enough"));
    plant(join(home, "a/b/c/d/e/Too Deep"));
    plant(join(home, ".hidden/Downloads"));
    plant(join(home, "elsewhere/Real"));
    symlinkSync(join(home, "elsewhere"), join(home, "link"));
    const result = discovery(shell, ["find_presences", home, NAMESPACE], env());
    assert.deepEqual(lines(result.out).sort(), [
      `${home}/Downloads`,
      `${home}/a/b/c/Deep Enough`,
      `${home}/elsewhere/Real`,
    ]);
    assert.deepEqual(lines(discovery(shell, ["find_presences", home, "other-ns"], env()).out), []);
  });

  await test(`${shell}: the candidates come in order, once each`, (context) => {
    const { home, userData, env, record } = lab(context);
    pointPreferencesAt(userData, `${home}/Custom`);
    writeFileSync(record, `downloadsRoot=${home}/Downloads\ndownloadsRoot=${home}/Recorded\n`);
    plant(join(home, "Found"));
    plant(join(home, "Recorded"));
    const result = discovery(
      shell,
      ["downloads_root_candidates", userData, "Default", record, NAMESPACE],
      env(),
    );
    assert.equal(result.code, 0);
    assert.deepEqual(lines(result.out), [
      `${home}/Custom`,
      `${home}/Downloads`,
      `${home}/Recorded`,
      `${home}/Found`,
    ]);
    assert.ok(!result.out.includes("\n\n"));
  });

  await test(`${shell}: a candidate without the token is skipped and the next one holding it wins`, (context) => {
    const { home, userData, env, record } = lab(context);
    pointPreferencesAt(userData, `${home}/Custom`);
    plant(`${home}/Custom`, OTHER_BOOT);
    plant(`${home}/Downloads`, PEER_BOOT);
    const result = discovery(
      shell,
      ["profile_downloads_root", userData, "Default", record, NAMESPACE, PEER_BOOT],
      env(),
    );
    assert.deepEqual([result.code, result.out], [0, `${home}/Downloads\n`]);
  });

  await test(`${shell}: the first candidate holding the token wins over a later one`, (context) => {
    const { home, userData, env, record } = lab(context);
    pointPreferencesAt(userData, `${home}/Custom`);
    plant(`${home}/Custom`, PEER_BOOT);
    plant(`${home}/Downloads`, PEER_BOOT);
    const result = discovery(
      shell,
      ["profile_downloads_root", userData, "Default", record, NAMESPACE, PEER_BOOT],
      env(),
    );
    assert.equal(result.out, `${home}/Custom\n`);
  });

  await test(`${shell}: the find step is the last candidate that can hold the token`, (context) => {
    const { home, userData, env, record } = lab(context);
    plant(`${home}/Somewhere/Odd`, PEER_BOOT);
    const result = discovery(
      shell,
      ["profile_downloads_root", userData, "Default", record, NAMESPACE, PEER_BOOT],
      env(),
    );
    assert.equal(result.out, `${home}/Somewhere/Odd\n`);
  });

  await test(`${shell}: no token anywhere exits 66 and names every candidate`, (context) => {
    const { home, userData, env, record } = lab(context);
    pointPreferencesAt(userData, `${home}/Custom`);
    writeFileSync(record, `downloadsRoot=${home}/Recorded\n`);
    plant(`${home}/Custom`, OTHER_BOOT);
    const result = discovery(
      shell,
      ["profile_downloads_root", userData, "Default", record, NAMESPACE, PEER_BOOT],
      env(),
    );
    assert.equal(result.code, EX_NOT_FOUND);
    assert.equal(result.out, "");
    assert.match(result.err, /not found: tried /);
    for (const root of ["Custom", "Downloads", "Recorded"])
      assert.ok(result.err.includes(`${home}/${root}`));
  });

  await test(`${shell}: a presence behind a link does not count as holding the token`, (context) => {
    const { home, userData, env, record } = lab(context);
    const folder = plant(`${home}/Elsewhere`, PEER_BOOT);
    const linked = join(home, "Downloads/RECnRun/poc", NAMESPACE, "peers", BOB);
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(folder, "presence.json"), join(linked, "presence.json"));
    const result = discovery(
      shell,
      ["profile_downloads_root", userData, "Default", record, NAMESPACE, PEER_BOOT],
      env(),
    );
    assert.equal(result.out, `${home}/Elsewhere\n`);
  });

  await test(`${shell}: a wrong call exits 64`, (context) => {
    const { env } = lab(context);
    assert.equal(discovery(shell, [], env()).code, 64);
    assert.equal(discovery(shell, ["rm"], env()).code, 64);
    assert.equal(discovery(shell, ["pref_download_dir", "/only-one"], env()).code, 64);
    const call = ["profile_downloads_root", "/r", "Default", "/rec", NAMESPACE, "not a token"];
    assert.equal(discovery(shell, call, env()).code, 64);
  });
}
