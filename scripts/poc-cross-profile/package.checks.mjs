import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { POC_EXTENSION_ID } from "../../apps/extension/scripts/poc-key.mjs";
import { firstRunScene } from "./first-run-lab.mjs";
import { ALICE, shells } from "./lab.mjs";
import { lines } from "./lifecycle-lab.mjs";
import { LIBRARIES, buildPackage, extensionIdOf } from "./package/build.mjs";
import { bareBin, builtPackage, fakeBuild, scratch } from "./package-lab.mjs";
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

const OS_FOLDERS = ["macos", "linux"];
const COMMANDS = ["first-run", "install", "start", "status", "stop", "autostart"];
const EX_NONE = 66;
const files = (directory) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));

/** The first fenced command of the README's "First command" section, as words. */
function firstCommand(readme) {
  const section = readme.split("## First command")[1] ?? "";
  const block = /```\n([^\n]+)\n```/.exec(section);
  assert.ok(block, "the README has a First command section with one fenced command");
  return block[1].split(" ");
}

await test("the packager writes one folder per OS with the allowlisted files only", (context) => {
  const { macos, linux } = builtPackage(scratch(context));
  const allowed = ["MANIFEST", "README.md", "recnrun-launcher", ...LIBRARIES];
  for (const folder of [macos, linux]) {
    const top = readdirSync(folder).sort();
    assert.deepEqual(top, ["extension", ...allowed].sort());
    for (const path of files(folder)) {
      assert.ok(!/\.(mjs|ts|map)$|node_modules/.test(path), `${path} must not ship`);
    }
    assert.ok(files(join(folder, "extension")).includes("manifest.json"));
  }
  assert.equal(OS_FOLDERS.length, 2);
  assert.match(readFileSync(join(macos, "README.md"), "utf8"), /shasum -a 256 -c MANIFEST/);
  assert.match(readFileSync(join(linux, "README.md"), "utf8"), /sha256sum -c MANIFEST/);
});

await test("the entry is an executable /bin/sh script and every script passes the scan", (context) => {
  const { macos, linux } = builtPackage(scratch(context));
  for (const folder of [macos, linux]) {
    accessSync(join(folder, "recnrun-launcher"), constants.X_OK);
    const entry = readFileSync(join(folder, "recnrun-launcher"), "utf8");
    assert.equal(entry.split("\n")[0], "#!/bin/sh");
    assert.deepEqual(scanText("recnrun-launcher", entry), []);
    assert.deepEqual(scanPackage(folder), []);
    assert.ok(LIBRARIES.filter((name) => name.endsWith(".sh")).length >= 8);
  }
});

await test("the extension folder is the POC build and the packager refuses any other", (context) => {
  const directory = scratch(context);
  const { macos } = builtPackage(directory);
  const manifest = JSON.parse(readFileSync(join(macos, "extension/manifest.json"), "utf8"));
  const pinned = readFileSync(join(macos, "extension-id"), "utf8").split("\n")[0];
  assert.equal(extensionIdOf(manifest.key), pinned);
  assert.equal(pinned, POC_EXTENSION_ID);
  const refuse = (manifest) => () =>
    buildPackage({
      extension: fakeBuild(scratch(context), manifest),
      out: join(directory, "refused"),
    });
  assert.throws(refuse({ key: undefined }), /not the POC build/);
  assert.throws(refuse({ key: "AAAA" }), /not the POC build/);
  assert.throws(refuse({ permissions: ["storage", "debugger"] }), /debugger/);
  assert.throws(
    () => buildPackage({ extension: join(directory, "missing"), out: directory }),
    /no manifest\.json/,
  );
});

await test("MANIFEST lists every file with its sum, verifies, and fails on a changed byte", (context) => {
  const directory = scratch(context);
  const { macos, linux } = builtPackage(directory);
  const listed = readFileSync(join(macos, "MANIFEST"), "utf8").trimEnd().split("\n");
  assert.deepEqual(
    listed.map((line) => line.slice(66)),
    files(macos)
      .filter((path) => path !== "MANIFEST")
      .sort(),
  );
  for (const line of listed) {
    const [digest, path] = [line.slice(0, 64), line.slice(66)];
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(macos, path)))
        .digest("hex"),
      digest,
    );
  }
  const verify = (folder) => {
    const tool =
      spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0
        ? ["sha256sum"]
        : ["shasum", "-a", "256"];
    return spawnSync(tool[0], [...tool.slice(1), "-c", "MANIFEST"], {
      cwd: folder,
      encoding: "utf8",
    });
  };
  assert.equal(verify(linux).status, 0);
  const copy = join(directory, "tampered");
  cpSync(linux, copy, { recursive: true });
  writeFileSync(join(copy, "open.sh"), `${readFileSync(join(copy, "open.sh"), "utf8")}# x\n`);
  assert.notEqual(verify(copy).status, 0);
});

await test("the README names a first command the entry accepts", (context) => {
  const { macos, linux } = builtPackage(scratch(context));
  const readme = readFileSync(join(macos, "README.md"), "utf8");
  assert.deepEqual(firstCommand(readme), ["sh", "recnrun-launcher", "first-run"]);
  assert.deepEqual(
    firstCommand(readFileSync(join(linux, "README.md"), "utf8")),
    firstCommand(readme),
  );
  for (const line of readme.split("\n").filter((it) => it.startsWith("sh recnrun-launcher"))) {
    assert.ok(COMMANDS.includes(line.split(" ")[2]), `${line} names a command the entry has`);
  }
  const flat = readme.replaceAll(/\s+/g, " ");
  assert.match(flat, /Count: 4 N \+ 3 for N profiles/);
  assert.match(flat, /gestures are estimated, not observed/);
  assert.match(flat, /observed by the host twin: `first-run` and `status`/);
  assert.doesNotMatch(readme, /Gesture count/);
});

await test("the README's first command, run verbatim, opens a profile; with none it exits 66", (context) => {
  const { macos } = builtPackage(scratch(context));
  const [program, ...args] = firstCommand(readFileSync(join(macos, "README.md"), "utf8"));
  const run = (vars) =>
    spawnSync(program, args, {
      cwd: macos,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...vars },
      timeout: 120_000,
    });
  const scene = firstRunScene(context);
  const done = run(scene.vars({ RECNRUN_OPEN_TIMEOUT_S: "2" }));
  assert.equal(done.status, 0, done.stderr);
  assert.equal(lines(done.stdout)[0], `${ALICE} open`);
  assert.match(
    readFileSync(join(scene.home, ".recnrun/launcher/profiles", ALICE), "utf8"),
    /^status=open$/m,
  );
  scene.unpublish();
  const empty = scratch(context);
  const none = run({
    HOME: empty,
    RECNRUN_DISCOVERY_PREFIX: empty,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
  });
  assert.equal(none.status, EX_NONE, none.stderr);
});

for (const shell of shells) {
  await test(`${shell}: the package runs with only sh and coreutils on PATH`, (context) => {
    const directory = scratch(context);
    const { linux } = builtPackage(directory);
    const bin = bareBin(directory);
    assert.deepEqual(
      readdirSync(bin).filter((name) => /^(node|jq|python3?|perl|ruby|bash)$/.test(name)),
      [],
    );
    const scene = firstRunScene(context);
    const vars = scene.vars({ PATH: bin, RECNRUN_OPEN_TIMEOUT_S: "2" });
    const run = (args) =>
      spawnSync(
        "env",
        [
          "-i",
          ...Object.entries(vars).map(([key, value]) => `${key}=${value}`),
          shell,
          "recnrun-launcher",
          ...args,
        ],
        {
          cwd: linux,
          encoding: "utf8",
          timeout: 120_000,
        },
      );
    const first = run(["first-run"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(lines(first.stdout)[0], `${ALICE} open`);
    const status = run(["status", join(scene.home, ".recnrun/launcher")]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^launcher stopped\n/);
    assert.match(status.stdout, new RegExp(`${ALICE} open `));
  });
}

await test("LIBRARIES holds every script the shipped scripts source or run", () => {
  const reference = /(?:^|\s)(?:\.|\/bin\/sh)\s+"[^\n]*?\/([\w-]+\.sh)"/gm;
  const shipped = ["package/recnrun-launcher", ...LIBRARIES.filter((name) => name.endsWith(".sh"))];
  for (const name of shipped) {
    const text = readFileSync(join(here, name), "utf8");
    for (const [, library] of text.matchAll(reference)) {
      assert.ok(LIBRARIES.includes(library), `${name} uses ${library}, which is not in LIBRARIES`);
    }
  }
  for (const library of [
    "catalog.sh",
    "presence.sh",
    "record.sh",
    "master-role.sh",
    "roots.sh",
    "provision.sh",
    "base.sh",
    "clone.sh",
    "clone-open.sh",
    "clone-control.sh",
    "lifecycle-control.sh",
  ]) {
    assert.ok(LIBRARIES.includes(library), `${library} ships`);
  }
  // V3: the launcher prepares the base and its clones on the colleague's machine.
  for (const entry of ["install.sh", "base.sh", "clone.sh", "clone-open.sh"]) {
    assert.ok(LIBRARIES.includes(entry), `${entry} ships`);
  }
});

await test("the README says the launcher keeps the catalog", (context) => {
  const { macos } = builtPackage(scratch(context));
  assert.match(
    readFileSync(join(macos, "README.md"), "utf8").replaceAll(/\s+/g, " "),
    /registry\.json/,
  );
});
