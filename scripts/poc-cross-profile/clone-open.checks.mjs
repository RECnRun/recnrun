import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { IDENTITY, NAMESPACE, shells } from "./lab.mjs";
import { EXTENSION, MARKER } from "./base-lab.mjs";
import { alive } from "./lifecycle-lab.mjs";
import { MARKER_FILE, MASTER, masterBlock, openScene, presenceWith } from "./clone-open-lab.mjs";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lines = (text) => text.split("\n").filter(Boolean);
const valueOf = (rows, key) => rows.find((row) => row.startsWith(`${key}=`))?.slice(key.length + 1);
const argvOf = (s) => readFileSync(join(s.home, "argv.txt"), "utf8").split("\n").slice(0, -1);
const presencePath = (s) =>
  join(s.home, "master-downloads/RECnRun/poc", NAMESPACE, "peers", MASTER);

/** The record block `open-clone` appends for the clone `c1`. */
const workerBlock = (s) =>
  [
    `userDataDir=${s.root}`,
    "profileDirectory=Default",
    `profileId=${s.instance()}`,
    `namespace=${NAMESPACE}`,
    "role=worker",
    `downloadsRoot=${s.root}/downloads`,
  ].join("\n");

for (const shell of shells) {
  await test(`${shell}: open-clone refuses a wrong call, a bad mode, and a clone that is none before any launch`, (context) => {
    const s = openScene(context, shell);
    const before = s.launches();
    assert.equal(s.open([s.clones, "c1", s.record]).code, 64);
    assert.equal(s.open([]).code, 64);
    for (const args of [
      [s.clones, "c1", s.record, NAMESPACE, "Headed"],
      [s.clones, "c1", s.record, NAMESPACE, "headed", "--evil"],
      [s.clones, "c1", s.record, "Bad Space"],
      [s.clones, "nope", s.record, NAMESPACE],
      [s.clones, "c1/..", s.record, NAMESPACE],
      [s.clones, ".c1.partial-0123456789abcdef", s.record, NAMESPACE],
      [join(s.home, "missing"), "c1", s.record, NAMESPACE],
    ]) {
      const result = s.open(args);
      assert.equal(result.code, 65, `${args.join(" ")}: ${result.err}`);
    }
    assert.equal(s.launches(), before, "no refusal started Chrome");
  });

  await test(`${shell}: open-clone refuses a root without a valid worker marker of this namespace`, (context) => {
    const s = openScene(context, shell);
    const before = s.launches();
    const marker = s.marker();
    const make = (name, text) => {
      mkdirSync(join(s.clones, name, "Default"), { recursive: true });
      if (text !== undefined) writeFileSync(join(s.clones, name, MARKER_FILE), text);
    };
    make("bare");
    make("junk", "not a marker\n");
    make(
      "master",
      marker.replace("clone=c1", "clone=master").replace("role=worker", "role=master"),
    );
    make("short", marker.split("\n").slice(0, 9).join("\n") + "\n");
    make("renamed", marker); // its clone= line names c1
    make("base-copy");
    writeFileSync(join(s.clones, "base-copy", MARKER), "setting=base-v1\n");
    const expected = { bare: /no \.recnrun-clone/, "base-copy": /frozen base/ };
    for (const name of ["bare", "junk", "master", "short", "renamed", "base-copy"]) {
      const result = s.open([s.clones, name, s.record, NAMESPACE]);
      assert.equal(result.code, 65, `${name}: ${result.err}`);
      if (expected[name]) assert.match(result.err, expected[name]);
    }
    const other = s.open([s.clones, "c1", s.record, "other-ns"]);
    assert.equal(other.code, 65, other.err);
    assert.match(other.err, /namespace/);
    assert.equal(s.launches(), before);
  });

  await test(`${shell}: open-clone refuses a record without exactly one master and a master without a presence key`, (context) => {
    const s = openScene(context, shell);
    const before = s.launches();
    const refused = (text, code, pattern) => {
      if (text !== undefined) s.setRecord(text);
      const result = s.open();
      assert.equal(result.code, code, result.err);
      assert.match(result.err, pattern);
    };
    const worker = masterBlock(s.home, "worker");
    refused(`${worker}\n`, 65, /role=master/);
    refused(
      `${masterBlock(s.home).replace(`namespace=${NAMESPACE}`, "namespace=other")}\n`,
      65,
      /role=master/,
    );
    refused(`${masterBlock(s.home)}\n\n${masterBlock(s.home)}\n`, 65, /2 blocks/);
    refused("userDataDir=relative\n", 65, /record line 1/);
    s.setRecord(`${masterBlock(s.home)}\n`);
    const file = join(presencePath(s), "presence.json");
    writeFileSync(file, presenceWith(undefined));
    refused(undefined, 66, /master presence not found/);
    writeFileSync(file, presenceWith({ ...IDENTITY, key: "B".repeat(86) }));
    refused(undefined, 66, /master presence not found/);
    writeFileSync(file, `${presenceWith(IDENTITY)}${" ".repeat(4096)}`);
    refused(undefined, 66, /master presence not found/);
    writeFileSync(file, presenceWith(IDENTITY));
    symlinkSync(file, join(presencePath(s), "link.json"));
    writeFileSync(join(presencePath(s), "presence.json"), "");
    refused(undefined, 66, /master presence not found/);
    const missing = join(s.home, "nowhere");
    refused(
      `${masterBlock(s.home).replace(`${s.home}/master-downloads`, missing)}\n`,
      66,
      /master presence not found/,
    );
    assert.equal(existsSync(join(s.home, "nope")), false);
    assert.equal(s.launches(), before);
    assert.equal(s.recordText().includes("role=worker"), false, "nothing was appended");
  });

  await test(`${shell}: open-clone starts Chrome on the clone with the clone URL and registers it on the ack`, (context) => {
    const s = openScene(context, shell);
    const marker = s.marker();
    const record = s.recordText();
    const before = Math.floor(Date.now() / 1000);
    const result = s.open(undefined, { STUB_CLONE: "good" });
    assert.equal(result.code, 0, result.err);
    assert.match(result.err, /pid=\d+/);
    const rows = lines(result.out);
    assert.deepEqual(
      rows.map((row) => row.slice(0, row.indexOf("="))),
      ["profileId", "operationId", "token", "boot", "root"],
    );
    const [instance, operation, token] = ["profileId", "operationId", "token"].map((key) =>
      valueOf(rows, key),
    );
    assert.equal(instance, s.instance());
    assert.match(operation, V4);
    assert.match(token, V4);
    assert.equal(valueOf(rows, "boot"), token);
    assert.equal(valueOf(rows, "root"), `${s.root}/downloads`);
    assert.deepEqual(argvOf(s), [
      `--user-data-dir=${s.root}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      `chrome-extension://${EXTENSION}/bootstrap.html#clone=${token}&instance=${instance}&operation=${operation}&namespace=${NAMESPACE}&master=${MASTER}.${IDENTITY.key}`,
    ]);
    assert.equal(s.recordText(), `${record}\n${workerBlock(s)}\n`);
    const added = s.marker().slice(marker.length);
    const stamp = Number(/^provisionedAt=(\d+)\n/.exec(added)?.[1]);
    assert.ok(stamp >= before && stamp <= before + 60, added);
    assert.equal(
      added.slice(added.indexOf("\n") + 1),
      `operationId=${operation}\nmasterProfileId=${MASTER}\n`,
    );
    assert.ok(s.marker().startsWith(marker), "the existing lines are not rewritten");
    const listed = s.clone(shell, ["list-clones", s.clones]);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`^c1 ${instance} base-v1 \\d+$`, "m"));
  });

  await test(`${shell}: open-clone headless adds one flag, and a record without a final newline keeps its blocks apart`, (context) => {
    const s = openScene(context, shell);
    s.setRecord(masterBlock(s.home));
    const result = s.open([s.clones, "c1", s.record, NAMESPACE, "headless"], {
      STUB_CLONE: "good",
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(argvOf(s)[0], "--headless=new");
    assert.equal(s.recordText(), `${masterBlock(s.home)}\n\n${workerBlock(s)}\n`);
  });

  const ignored = [
    { title: "without provisioned", extra: { STUB_CLONE: "unprovisioned" } },
    { title: "of another instance", extra: { STUB_CLONE: "good", STUB_BODY_INSTANCE: MASTER } },
    {
      title: "of another operation",
      extra: { STUB_CLONE: "good", STUB_BODY_OPERATION: "99999999-9999-4999-8999-999999999999" },
    },
    {
      title: "of another token",
      extra: { STUB_CLONE: "good", STUB_BODY_TOKEN: "99999999-9999-4999-8999-999999999999" },
    },
    { title: "behind a symbolic link", extra: { STUB_CLONE: "symlink" } },
    { title: "over 4096 bytes", extra: { STUB_CLONE: "oversize" } },
    { title: "that never comes", extra: {} },
  ];
  for (const { title, extra } of ignored) {
    await test(`${shell}: an ack ${title} is ignored: exit 69, the candidates tried, nothing registered`, (context) => {
      const s = openScene(context, shell);
      const marker = s.marker();
      const record = s.recordText();
      const result = s.open(undefined, { RECNRUN_OPEN_TIMEOUT_S: "1", ...extra });
      assert.equal(result.code, 69, result.err);
      assert.equal(result.out, "");
      assert.match(result.err, new RegExp(`tried ${s.root}/downloads, `));
      assert.match(result.err, /master-downloads/);
      assert.equal(s.recordText(), record);
      assert.equal(s.marker(), marker);
    });
  }

  await test(`${shell}: an ack below a linked folder is ignored and the Chrome it started keeps running`, (context) => {
    const s = openScene(context, shell);
    mkdirSync(join(s.home, "real/poc"), { recursive: true });
    mkdirSync(join(s.root, "downloads"), { recursive: true });
    symlinkSync(join(s.home, "real"), join(s.root, "downloads/RECnRun"));
    const result = s.open(undefined, {
      RECNRUN_OPEN_TIMEOUT_S: "1",
      STUB_CLONE: "good",
      STUB_ALIVE: "30",
    });
    assert.equal(result.code, 69, result.err);
    const pid = Number(/\bpid=(\d+)/.exec(result.err)?.[1]);
    assert.ok(pid > 0 && alive(pid), "the stub Chrome runs on");
  });

  await test(`${shell}: open-clone refuses while a process names the clone root`, (context) => {
    const s = openScene(context, shell);
    const pid = s.holdClone();
    const before = s.launches();
    const result = s.open(undefined, { STUB_CLONE: "good" });
    assert.equal(result.code, 75, result.err);
    assert.match(result.err, new RegExp(`${pid}`));
    assert.equal(s.launches(), before);
    assert.equal(s.recordText().includes("role=worker"), false);
  });

  await test(`${shell}: a registered clone is reopened through open.sh and nothing is appended`, (context) => {
    const s = openScene(context, shell);
    assert.equal(s.open(undefined, { STUB_CLONE: "good" }).code, 0);
    const record = s.recordText();
    const marker = s.marker();
    const launched = s.launches();
    const result = s.open(undefined, { STUB_REOPEN: "1", STUB_PROFILE: s.instance() });
    assert.equal(result.code, 0, result.err);
    const rows = lines(result.out);
    assert.deepEqual(
      rows.map((row) => row.slice(0, row.indexOf("="))),
      ["root", "boot", "token"],
    );
    const url = argvOf(s).at(-1);
    assert.equal(
      url,
      `chrome-extension://${EXTENSION}/bootstrap.html#token=${valueOf(rows, "token")}`,
    );
    assert.equal(s.launches(), launched + 1);
    assert.equal(s.recordText(), record);
    assert.equal(s.marker(), marker);
    const silent = s.open(undefined, { RECNRUN_OPEN_TIMEOUT_S: "1" });
    assert.equal(silent.code, 69, "the status of open.sh is the status of open-clone");
    assert.equal(s.recordText(), record);
  });

  await test(`${shell}: open-clone refuses a provisioned marker that the record does not register and a block of another root`, (context) => {
    const s = openScene(context, shell);
    assert.equal(s.open(undefined, { STUB_CLONE: "good" }).code, 0);
    const launched = s.launches();
    const other = workerBlock(s).replace(`userDataDir=${s.root}`, `userDataDir=${s.home}/Master`);
    s.setRecord(`${masterBlock(s.home)}\n\n${other}\n`);
    const moved = s.open();
    assert.equal(moved.code, 65, moved.err);
    assert.match(moved.err, /another/);
    s.setRecord(`${masterBlock(s.home)}\n`);
    const lost = s.open();
    assert.equal(lost.code, 65, lost.err);
    assert.match(lost.err, /provisioned/);
    assert.equal(s.launches(), launched);
  });

  await test(`${shell}: open-clone refuses 66 while the unpacked build of the clone is gone (CL13)`, (context) => {
    const s = openScene(context, shell);
    const build = resolve(s.bases, "../unpacked-build");
    const before = s.launches();
    renameSync(build, `${build}-away`);
    const missing = s.open();
    assert.equal(missing.code, 66, missing.err);
    assert.match(missing.err, new RegExp(`unpacked code missing: ${build}\n`));
    assert.equal(s.launches(), before, "nothing started Chrome");
    renameSync(`${build}-away`, build);
    const restored = s.open([s.clones, "c1", s.record, NAMESPACE], { RECNRUN_OPEN_TIMEOUT_S: "1" });
    assert.equal(restored.code, 69, restored.err);
    assert.equal(s.launches(), before + 1, "the restored build opens");
  });
}
