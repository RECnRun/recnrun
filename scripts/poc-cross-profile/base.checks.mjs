import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
import { EXTENSION, MARKER, baseScene, installExtension } from "./base-lab.mjs";
import { firstRun, firstRunScene } from "./first-run-lab.mjs";
import { alive } from "./lifecycle-lab.mjs";
import { open, request, scene as openScene } from "./open-lab.mjs";

const EX_USAGE = 64;
const EX_REFUSED = 65;
const EX_NO_ACK = 69;
const EX_STILL_RUNNING = 70;
const EX_EXISTS = 73;
const EX_HELD = 75;
const pidOf = (result) => Number(/\bpid=(\d+)/.exec(result.err)?.[1]);
const lines = (text) => text.split("\n").filter(Boolean);

for (const shell of shells) {
  await test(`${shell}: create-base refuses an existing root, a link in its place, and bad names`, (context) => {
    const s = baseScene(context);
    mkdirSync(s.root("base-v1"));
    const taken = s.create(shell);
    assert.equal(taken.code, EX_EXISTS, taken.err);
    assert.match(taken.err, /exists/);
    symlinkSync(s.home, s.root("base-v2"));
    assert.equal(s.create(shell, "base-v2").code, EX_EXISTS);
    for (const name of ["base-v", "Base-v1", "base-v1x", "base-v1.2", "base-1", "x", "base-v1 "]) {
      assert.equal(s.create(shell, name).code, EX_REFUSED, name);
    }
    assert.equal(s.launchCount(), 0, "no refusal started Chrome");
  });

  await test(`${shell}: create-base refuses a bases dir that is no plain directory and a root with odd characters`, (context) => {
    const s = baseScene(context);
    const file = join(s.home, "file");
    writeFileSync(file, "");
    symlinkSync(s.bases, join(s.home, "linked"));
    for (const dir of [join(s.home, "missing"), file, "relative", join(s.home, "linked")]) {
      const result = s.run(shell, ["create-base", dir, "base-v1"], "base-v1");
      assert.equal(result.code, EX_REFUSED, `${dir}: ${result.err}`);
    }
    for (const odd of ["a b", "a'b", "a\\b", 'a"b']) {
      mkdirSync(join(s.home, odd));
      const result = s.run(shell, ["create-base", join(s.home, odd), "base-v1"], "base-v1");
      assert.equal(result.code, EX_REFUSED, `${odd}: ${result.err}`);
    }
    assert.equal(s.run(shell, ["create-base", s.bases], "base-v1").code, EX_USAGE);
    assert.equal(s.launchCount(), 0);
  });

  await test(`${shell}: create-base pins the Downloads root and starts Chrome on the new root without waiting`, (context) => {
    const s = baseScene(context);
    const result = s.create(shell, "base-v1", { STUB_ALIVE: "30" });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, `root=${s.root()}\n`);
    assert.ok(pidOf(result) > 0 && alive(pidOf(result)), "the stub Chrome runs in the background");
    assert.deepEqual(s.argv(), [
      `--user-data-dir=${s.root()}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "chrome://extensions/",
      "chrome://version/",
    ]);
    const preferences = JSON.parse(readFileSync(join(s.root(), "Default/Preferences"), "utf8"));
    assert.equal(preferences.download.default_directory, `${s.root()}/downloads`);
    assert.equal(preferences.download.prompt_for_download, false);
    assert.equal(existsSync(join(s.root(), MARKER)), false);
  });

  await test(`${shell}: template waits for the template ack of its setting and prints the profile`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    const result = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", {
      STUB_ACK: "good",
    });
    assert.equal(result.code, 0, result.err);
    const out = lines(result.out);
    const token = /^token=(.+)$/.exec(out[1])?.[1] ?? "";
    assert.deepEqual(out, [`profileId=${ALICE}`, `token=${token}`, `root=${s.root()}/downloads`]);
    assert.deepEqual(s.argv(), [
      `--user-data-dir=${s.root()}`,
      "--profile-directory=Default",
      `chrome-extension://${EXTENSION}/bootstrap.html#template=${token}&setting=base-v1`,
    ]);
  });

  await test(`${shell}: template ignores an ack without the template fields or with another setting`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    for (const extra of [
      { STUB_ACK: "plain" },
      { STUB_ACK: "good", STUB_SETTING: "base-v2" },
      {},
    ]) {
      const result = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", extra);
      assert.equal(result.code, EX_NO_ACK, `${JSON.stringify(extra)}: ${result.err}`);
      assert.match(result.err, /no template ack/);
    }
  });

  await test(`${shell}: template refuses a frozen base, a bad name, and a bad namespace before any launch`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    const launched = s.launchCount();
    writeFileSync(join(s.root(), MARKER), "setting=base-v1\n");
    const frozen = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1");
    assert.equal(frozen.code, EX_REFUSED);
    assert.match(frozen.err, /frozen/);
    for (const args of [
      [s.bases, "base-1", NAMESPACE],
      [s.bases, "base-v1", "Bad Space"],
      [join(s.home, "missing"), "base-v1", NAMESPACE],
    ]) {
      assert.equal(s.run(shell, ["template", ...args], "base-v1").code, EX_REFUSED, args.join(" "));
    }
    assert.equal(s.launchCount(), launched);
  });

  await test(`${shell}: quit signals only the Chrome whose command line names the root`, (context) => {
    const s = baseScene(context);
    const first = s.create(shell, "base-v1", { STUB_ALIVE: "30" });
    const other = s.create(shell, "base-v2", { STUB_ALIVE: "30" });
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    s.spawned.push(bystander.pid);
    const quit = s.run(shell, ["quit", s.bases, "base-v1"], "base-v1");
    assert.equal(quit.code, 0, quit.err);
    assert.equal(alive(pidOf(first)), false);
    assert.equal(alive(pidOf(other)), true, "another root's Chrome keeps running");
    assert.equal(alive(bystander.pid), true);
    const again = s.run(shell, ["quit", s.bases, "base-v1"], "base-v1");
    assert.equal(again.code, 0);
    assert.match(again.err, /not running/);
  });

  await test(`${shell}: quit exits 70 while a process still names the root`, (context) => {
    const s = baseScene(context);
    const stubborn = s.create(shell, "base-v1", { STUB_ALIVE: "30", STUB_DEAF: "1" });
    const quit = s.run(shell, ["quit", s.bases, "base-v1"], "base-v1", {
      RECNRUN_LIFECYCLE_STOP_S: "1",
    });
    assert.equal(quit.code, EX_STILL_RUNNING, quit.err);
    assert.equal(alive(pidOf(stubborn)), true);
  });

  await test(`${shell}: freeze refuses while a process holds the root, naming it`, (context) => {
    const s = baseScene(context);
    const held = s.create(shell, "base-v1", { STUB_ALIVE: "30" });
    installExtension(s.root());
    const result = s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
    assert.equal(result.code, EX_HELD, result.err);
    assert.match(result.err, new RegExp(`a process holds the root.*${pidOf(held)}`));
    assert.equal(existsSync(join(s.root(), MARKER)), false);
  });

  await test(`${shell}: freeze refuses without the extension, the Preferences, or the template ack`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    const freeze = () =>
      s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
    const bare = freeze();
    assert.equal(bare.code, EX_REFUSED, bare.err);
    assert.match(bare.err, /extension/);
    installExtension(s.root());
    const unacked = freeze();
    assert.equal(unacked.code, EX_REFUSED, unacked.err);
    assert.match(unacked.err, /template ack/);
    const plain = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", {
      STUB_ACK: "plain",
    });
    assert.equal(plain.code, EX_NO_ACK);
    assert.equal(
      freeze().code,
      EX_REFUSED,
      "an ack without the template fields is no template ack",
    );
    assert.equal(
      s.run(shell, ["freeze", s.bases, "base-v1", "Bad Space", EXTENSION], "base-v1").code,
      EX_REFUSED,
    );
    assert.equal(
      s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, "nope"], "base-v1").code,
      EX_REFUSED,
    );
    assert.equal(existsSync(join(s.root(), MARKER)), false);
  });

  await test(`${shell}: freeze refuses a base with no Preferences`, (context) => {
    const s = baseScene(context);
    mkdirSync(join(s.root(), "Default"), { recursive: true });
    const result = s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.match(result.err, /Preferences/);
  });

  await test(`${shell}: freeze writes the marker once, never touches Default, and refuses another setting`, (context) => {
    const s = baseScene(context);
    assert.equal(s.create(shell).code, 0);
    const build = installExtension(s.root(), { unpacked: true });
    const acked = s.run(shell, ["template", s.bases, "base-v1", NAMESPACE], "base-v1", {
      STUB_ACK: "good",
    });
    assert.equal(acked.code, 0, acked.err);
    const preferences = readFileSync(join(s.root(), "Default/Preferences"), "utf8");
    const freeze = () =>
      s.run(shell, ["freeze", s.bases, "base-v1", NAMESPACE, EXTENSION], "base-v1");
    const before = Math.floor(Date.now() / 1000);
    const frozen = freeze();
    assert.equal(frozen.code, 0, frozen.err);
    const marker = join(s.root(), MARKER);
    const text = readFileSync(marker, "utf8");
    const rows = lines(text);
    assert.deepEqual(rows.slice(0, 4), [
      "setting=base-v1",
      `extensionId=${EXTENSION}`,
      `profileId=${ALICE}`,
      `namespace=${NAMESPACE}`,
    ]);
    const stamp = Number(/^frozenAt=(\d+)$/.exec(rows[4])?.[1]);
    assert.ok(stamp >= before && stamp <= before + 60, rows[4]);
    assert.equal(rows[5], "install=unpacked");
    assert.equal(rows[6], `unpackedPath=${build}`);
    assert.equal(rows.length, 7);
    assert.equal(frozen.out, text);
    assert.equal(readFileSync(join(s.root(), "Default/Preferences"), "utf8"), preferences);
    const time = statSync(marker).mtimeMs;
    const again = freeze();
    assert.equal(again.code, 0, again.err);
    assert.equal(again.out, text);
    assert.equal(statSync(marker).mtimeMs, time, "the marker was not rewritten");
    writeFileSync(marker, text.replace("setting=base-v1", "setting=base-v9"));
    const other = freeze();
    assert.equal(other.code, EX_REFUSED, other.err);
    assert.match(other.err, /another setting/);
  });

  await test(`${shell}: open and bind refuse a frozen root before any launch`, (context) => {
    const s = openScene(context);
    writeFileSync(join(s.root, MARKER), "setting=base-v1\n");
    const opened = open(shell, request(s.record), s.env());
    assert.equal(opened.code, EX_REFUSED, opened.err);
    assert.match(opened.err, /a frozen base is not an executor/);
    const bound = open(shell, ["bind", s.root, "Default", NAMESPACE], s.env());
    assert.equal(bound.code, EX_REFUSED, bound.err);
    assert.match(bound.err, /a frozen base is not an executor/);
    assert.equal(existsSync(s.argv), false, "Chrome never started");
  });

  await test(`${shell}: first-run skips a frozen root and says so`, (context) => {
    const s = firstRunScene(context);
    writeFileSync(join(s.root, MARKER), "setting=base-v1\n");
    const result = firstRun(
      shell,
      [s.state, s.record, "lab"],
      s.vars({ RECNRUN_OPEN_TIMEOUT_S: "2" }),
    );
    assert.equal(result.code, 66, result.err);
    assert.match(result.err, /frozen base/);
    assert.equal(existsSync(s.record), false);
    assert.equal(s.launches(), 0);
  });

  await test(`${shell}: catalog skips the Downloads root of a frozen base and keeps the others`, (context) => {
    const l = lab(context);
    const frozen = join(l.home, "bases/base-v1");
    const pinned = join(frozen, "downloads");
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(frozen, MARKER), "setting=base-v1\n");
    announce(pinned, presence(ALICE));
    announce(l.rootA, presence(BOB));
    const block = (user, downloads) =>
      `userDataDir=${user}\nprofileDirectory=Default\nprofileId=${user === l.home ? BOB : ALICE}\nnamespace=${NAMESPACE}\ndownloadsRoot=${downloads}\n`;
    writeFileSync(l.record, `${block(frozen, pinned)}\n${block(l.home, l.rootA)}`);
    const result = run(shell, [l.record, NAMESPACE, l.out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /the Downloads root of a frozen base/);
    assert.deepEqual(Object.keys(readRegistry(l.out).peers), [BOB]);
  });
}
