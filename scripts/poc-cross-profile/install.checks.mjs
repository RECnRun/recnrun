import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXTENSION, MARKER } from "./base-lab.mjs";
import { OTHER, SESSION, TARGET, installScene, writeBase } from "./install-lab.mjs";
import { shells } from "./lab.mjs";
import { alive } from "./lifecycle-lab.mjs";

const EX_USAGE = 64;
const EX_REFUSED = 65;
const EX_NO_REPLY = 69;
const EX_FAILED = 70;
const EX_HELD = 75;
const pidOf = (result) => Number(/\bpid=(\d+)/.exec(result.err)?.[1]);

/** The commands install-base sends, in order, for the build at `build`. */
function expectedMessages(build) {
  const evaluate = (id, expression) => ({
    id,
    sessionId: SESSION,
    method: "Runtime.evaluate",
    params: { expression, awaitPromise: true, returnByValue: true },
  });
  return [
    { id: 1, method: "Extensions.loadUnpacked", params: { path: build } },
    { id: 2, method: "Target.createTarget", params: { url: "chrome://extensions/" } },
    { id: 3, method: "Target.attachToTarget", params: { targetId: TARGET, flatten: true } },
    evaluate(
      4,
      "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}).then(()=>chrome.developerPrivate.getProfileConfiguration()).then((c)=>c.inDeveloperMode===true)",
    ),
    evaluate(5, `chrome.developerPrivate.reload('${EXTENSION}',{failQuietly:true}).then(()=>true)`),
    evaluate(
      6,
      `chrome.developerPrivate.getExtensionInfo('${EXTENSION}').then((i)=>i.state==='ENABLED')`,
    ),
    { id: 7, method: "Browser.close", params: {} },
  ];
}

for (const shell of shells) {
  await test(`${shell}: install-base refuses a bad request before Chrome starts`, (context) => {
    const s = installScene(context);
    const missing = s.install(shell);
    assert.equal(missing.code, EX_REFUSED, `no root yet: ${missing.err}`);
    const root = writeBase(s.bases);
    for (const [name, namespace] of [
      ["base-1", "lab-1"],
      ["Base-v1", "lab-1"],
      [".base-v1.partial-0123456789abcdef", "lab-1"],
      ["base-v1", "Lab"],
      ["base-v1", "lab 1"],
    ]) {
      const result = s.install(shell, {}, name, namespace);
      assert.equal(result.code, EX_REFUSED, `${name} ${namespace}: ${result.err}`);
    }
    const builds = [join(s.home, "nothing"), "relative", join(s.home, "odd build")];
    mkdirSync(join(s.home, "odd build"));
    writeFileSync(join(s.home, "odd build/manifest.json"), "{}");
    mkdirSync(join(s.home, "empty"));
    builds.push(join(s.home, "empty"));
    symlinkSync(s.build, join(s.home, "linked"));
    builds.push(join(s.home, "linked"));
    for (const build of builds) {
      const result = s.run(shell, ["install-base", s.bases, "base-v1", "lab-1", build]);
      assert.equal(result.code, EX_REFUSED, `${build}: ${result.err}`);
    }
    assert.equal(s.run(shell, ["install-base", s.bases, "base-v1", "lab-1"]).code, EX_USAGE);
    writeFileSync(join(root, MARKER), "setting=base-v1\n");
    const frozen = s.install(shell);
    assert.equal(frozen.code, EX_REFUSED, frozen.err);
    assert.match(frozen.err, /frozen base/);
    assert.deepEqual(s.launches(), [], "no refusal started Chrome");
  });

  await test(`${shell}: install-base refuses a root whose Downloads root is not pinned inside it`, (context) => {
    const s = installScene(context);
    const root = writeBase(s.bases);
    writeFileSync(join(root, "Default/Preferences"), "{}");
    const result = s.install(shell);
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.match(result.err, /does not pin the Downloads root/);
    assert.deepEqual(s.launches(), []);
  });

  await test(`${shell}: install-base refuses with 75 while a process names the root`, (context) => {
    const s = installScene(context);
    const root = writeBase(s.bases);
    const holder = spawn("sh", ["-c", "sleep 30; :", "sh", `--user-data-dir=${root}`, "--x"], {
      stdio: "ignore",
    });
    s.spawned.push(holder.pid);
    const result = s.install(shell);
    assert.equal(result.code, EX_HELD, result.err);
    assert.match(result.err, new RegExp(`a process holds the root: pids ${holder.pid}`));
    assert.deepEqual(s.launches(), []);
  });

  await test(`${shell}: install-base loads the build over the pipe, keeps it, and closes Chrome`, (context) => {
    const s = installScene(context);
    const root = writeBase(s.bases);
    const result = s.install(shell);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, new RegExp(`^extensionId=${EXTENSION}\ninstallS=\\d+\n$`));
    assert.deepEqual(s.argv(), [
      `--user-data-dir=${root}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
    ]);
    assert.deepEqual(s.messages(), expectedMessages(s.build));
    assert.equal(alive(pidOf(result)), false, "Chrome exited on Browser.close");
    assert.match(readFileSync(join(root, "Default/Secure Preferences"), "utf8"), /"location":4/);
  });

  await test(`${shell}: install-base exits 70 when the pipe loads another id, and closes Chrome`, (context) => {
    const s = installScene(context);
    writeBase(s.bases);
    const result = s.install(shell, { STUB_REPLY: "other" });
    assert.equal(result.code, EX_FAILED, result.err);
    assert.match(result.err, new RegExp(`loaded ${OTHER}, not ${EXTENSION}`));
    assert.deepEqual(
      s.messages().map((message) => message.method),
      ["Extensions.loadUnpacked", "Browser.close"],
    );
    assert.equal(alive(pidOf(result)), false);
    assert.equal(result.out, "");
  });

  await test(`${shell}: install-base exits 69 with no reply and leaves Chrome for lifecycle.sh stop`, (context) => {
    const s = installScene(context);
    writeBase(s.bases);
    const result = s.install(shell, { STUB_REPLY: "silent" });
    assert.equal(result.code, EX_NO_REPLY, result.err);
    assert.match(
      result.err,
      /no reply to Extensions\.loadUnpacked within 2 s: sent Extensions\.loadUnpacked/,
    );
    assert.equal(alive(pidOf(result)), true, "the Chrome that never answered still runs");
    assert.equal(result.out, "");
  });

  await test(`${shell}: install-base exits 70 when Chrome kept no settings entry`, (context) => {
    const s = installScene(context);
    writeBase(s.bases);
    const result = s.install(shell, { STUB_REPLY: "noentry" });
    assert.equal(result.code, EX_FAILED, result.err);
    assert.match(result.err, new RegExp(`kept no settings entry of ${EXTENSION}`));
    assert.equal(result.out, "");
  });

  await test(`${shell}: install-base signals its own Chrome only after a full wait for Browser.close`, (context) => {
    const s = installScene(context);
    writeBase(s.bases);
    const result = s.install(shell, { STUB_REPLY: "linger" });
    assert.equal(result.code, 0, result.err);
    assert.match(result.err, /still runs 2 s after Browser.close: SIGTERM/);
    assert.deepEqual(s.launches(), ["launch", "term"]);
    assert.equal(alive(pidOf(result)), false);
  });
}
