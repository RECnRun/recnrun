import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, NAMESPACE, shells } from "./lab.mjs";
import { EXTENSION, installExtension } from "./base-lab.mjs";
import { masterBlock } from "./clone-open-lab.mjs";
import { pipeChrome } from "./install-lab.mjs";
import { OPERATION, provisionScene, requestText } from "./provision-lab.mjs";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The status without its clock, and the proof that the file is the closed layout. */
function shape(status) {
  const { raw, updatedAt, ...rest } = status;
  assert.equal(raw, JSON.stringify({ ...rest, updatedAt }), "key order and no extra bytes");
  assert.equal(Number.isSafeInteger(updatedAt) && updatedAt > 1_700_000_000_000, true);
  return rest;
}

/** A finished operation is left alone, and status prints its state file. */
function assertSettled(s, shell) {
  const before = s.status().raw;
  const launches = s.launchCount();
  assert.equal(s.run(shell).code, 0);
  assert.equal(s.status().raw, before, "a finished operation is left alone");
  assert.equal(s.launchCount(), launches);
  assert.equal(s.run(shell, {}, ["status", s.state, OPERATION]).out, s.stateText());
}

for (const shell of shells) {
  await test(`${shell}: run advances one step per call and writes the status after each`, (context) => {
    const s = provisionScene(context);
    s.request();
    const calls = [];
    const call = (extra) => {
      const result = s.run(shell, extra);
      assert.equal(result.code, 0, result.err);
      calls.push(shape(s.status()));
      return calls.at(-1);
    };
    const first = call();
    assert.deepEqual(
      [first.step, first.state, first.message, first.clones],
      ["create-base", "running", "created base-v1", []],
    );
    assert.equal(first.operationId, OPERATION);
    installExtension(s.root(), { unpacked: true });
    const second = call();
    assert.deepEqual([second.step, second.state], ["install", "running"]);
    const gesture = { STUB_ACK: "good", STUB_ROOT: join(s.root(), "downloads") };
    assert.deepEqual([call(gesture).step, calls.at(-1).state], ["template", "running"]);
    assert.deepEqual([call().step, calls.at(-1).state], ["freeze", "running"]);
    const created = call();
    assert.deepEqual([created.step, created.state], ["create-clone", "running"]);
    assert.deepEqual(
      created.clones.map((it) => [it.name, it.boot, it.acked]),
      [
        ["w1", "", false],
        ["w2", "", false],
      ],
    );
    for (const clone of created.clones) assert.match(clone.instanceId, V4);
    const opened = call({ STUB_CLONE: "1" });
    assert.deepEqual([opened.step, opened.state], ["open-clone", "running"]);
    assert.deepEqual(
      opened.clones.map((it) => [it.name, it.instanceId, it.acked]),
      created.clones.map((it) => [it.name, it.instanceId, true]),
    );
    for (const clone of opened.clones) assert.match(clone.boot, V4);
    assert.equal(s.launchCount(), 4, "base, template, and two clones launched Chrome once each");
    const done = call();
    assert.deepEqual(
      [done.step, done.state, done.message],
      ["done", "done", "the workers are ready"],
    );
    assert.match(s.recordText(), /role=worker/);
    assertSettled(s, shell);
  });

  await test(`${shell}: a failed step is error until retry, then the same step runs again`, (context) => {
    const s = provisionScene(context);
    s.request();
    mkdirSync(join(s.bases, "clones/w1"), { recursive: true });
    assert.equal(s.run(shell).code, 0);
    installExtension(s.root(), { unpacked: true });
    s.run(shell);
    s.run(shell, { STUB_ACK: "good", STUB_ROOT: join(s.root(), "downloads") });
    s.run(shell);
    s.run(shell);
    const failed = shape(s.status());
    assert.deepEqual([failed.step, failed.state], ["create-clone", "error"]);
    assert.match(failed.message, /^exit 73: .*w1 exists$/);
    assert.doesNotMatch(failed.message, /["\\]/);
    const raw = s.status().raw;
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().raw, raw, "an error waits for retry");
    rmSync(join(s.bases, "clones/w1"), { recursive: true });
    writeFileSync(join(s.folder(), "retry"), "");
    assert.equal(s.run(shell).code, 0);
    const again = shape(s.status());
    assert.deepEqual(
      [again.step, again.state, again.clones.length],
      ["create-clone", "running", 2],
    );
    assert.equal(existsSync(join(s.folder(), "retry")), false, "retry is consumed");
    writeFileSync(join(s.folder(), "retry"), "x");
    const next = s.run(shell, { STUB_CLONE: "unprovisioned" });
    assert.equal(next.code, 0, next.err);
    const opening = shape(s.status());
    assert.deepEqual([opening.step, opening.state], ["open-clone", "error"]);
    assert.equal(
      existsSync(join(s.folder(), "retry")),
      true,
      "a retry file with content is not a retry",
    );
    s.run(shell);
    assert.equal(shape(s.status()).state, "error");
  });

  await test(`${shell}: the template without an ack is pending-action and repeats`, (context) => {
    const s = provisionScene(context);
    s.request();
    s.run(shell);
    installExtension(s.root(), { unpacked: true });
    s.run(shell);
    const timeout = { RECNRUN_OPEN_TIMEOUT_S: "1" };
    s.run(shell, timeout);
    const pending = shape(s.status());
    assert.deepEqual([pending.step, pending.state], ["template", "pending-action"]);
    assert.match(pending.message, /template gesture/);
    s.run(shell, { STUB_ACK: "good", STUB_ROOT: join(s.root(), "downloads") });
    assert.deepEqual([shape(s.status()).step, shape(s.status()).state], ["template", "running"]);
  });

  await test(`${shell}: install calls install.sh install-base on a base without the extension`, (context) => {
    const s = provisionScene(context);
    s.request();
    const build = pipeChrome(s.home);
    s.run(shell);
    const pipe = {
      STUB_MESSAGES: join(s.home, "messages"),
      STUB_EXTENSION: EXTENSION,
      STUB_BUILD: build,
      TMPDIR: s.home,
      RECNRUN_EXTENSION_BUILD: build,
    };
    const result = s.run(shell, pipe);
    assert.equal(result.code, 0, result.err);
    const installed = shape(s.status());
    assert.deepEqual([installed.step, installed.state], ["install", "running"]);
    assert.equal(installed.message, "installed the extension in the base");
    assert.match(
      readFileSync(join(s.root(), "Default/Secure Preferences"), "utf8"),
      /"location":4/,
    );
  });

  await test(`${shell}: a failed install.sh is an error with its exit code and last line`, (context) => {
    const s = provisionScene(context);
    s.request();
    s.run(shell);
    s.run(shell, { RECNRUN_EXTENSION_BUILD: join(s.home, "no-build") });
    const failed = shape(s.status());
    assert.deepEqual([failed.step, failed.state], ["install", "error"]);
    assert.match(failed.message, /^exit 65: .*build/);
  });

  await test(`${shell}: run ignores what it cannot trust and answers a refusable request`, (context) => {
    const s = provisionScene(context);
    mkdirSync(join(s.ops, "not-a-uuid"));
    writeFileSync(join(s.ops, "not-a-uuid/request.json"), requestText({ basesDir: s.bases }));
    s.request({}, OTHER);
    writeFileSync(
      join(s.folder(OTHER), "request.json"),
      `${requestText({ basesDir: s.bases })}${" ".repeat(4100)}`,
    );
    const linked = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mkdirSync(s.folder(linked));
    writeFileSync(
      join(s.home, "elsewhere.json"),
      requestText({ operationId: linked, basesDir: s.bases }),
    );
    symlinkSync(join(s.home, "elsewhere.json"), join(s.folder(linked), "request.json"));
    const folderLink = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mkdirSync(join(s.home, "real-op"));
    writeFileSync(
      join(s.home, "real-op/request.json"),
      requestText({ operationId: folderLink, basesDir: s.bases }),
    );
    symlinkSync(join(s.home, "real-op"), s.folder(folderLink));
    const result = s.run(shell);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(readdirSync(join(s.state, "ops")), []);
    for (const id of [OTHER, linked]) assert.equal(s.hasStatus(id), false, id);
    assert.equal(existsSync(join(s.home, "real-op/status.json")), false);
    assert.equal(s.launchCount(), 0);
    assert.match(result.err, /ignored/);
  });

  await test(`${shell}: run answers a request with a bad value and starts nothing`, (context) => {
    const s = provisionScene(context);
    const cases = [
      [{ basesDir: "../x" }, /basesDir/],
      [{ basesDir: "relative" }, /basesDir/],
      [{ clones: 0 }, /clones/],
      [{ clones: 9 }, /clones/],
      [{ baseName: "base-vx" }, /closed grammar/],
      [{ namespace: "other-1" }, /closed grammar/],
      [{ masterProfileId: ALICE }, /closed grammar/],
      [{ kind: "prepare" }, /closed grammar/],
    ];
    for (const [overrides, pattern] of cases) {
      rmSync(s.folder(), { recursive: true, force: true });
      rmSync(join(s.state, "ops"), { recursive: true, force: true });
      s.request(overrides);
      assert.equal(s.run(shell).code, 0);
      const status = shape(s.status());
      assert.deepEqual(
        [status.step, status.state],
        ["create-base", "error"],
        JSON.stringify(overrides),
      );
      assert.match(status.message, pattern);
      assert.match(status.message, /^refused: /);
    }
    rmSync(s.folder(), { recursive: true, force: true });
    rmSync(join(s.state, "ops"), { recursive: true, force: true });
    mkdirSync(s.folder());
    writeFileSync(join(s.folder(), "request.json"), `${requestText({ basesDir: s.bases })} `);
    s.run(shell);
    assert.equal(shape(s.status()).state, "error", "a byte after the closing brace");
    assert.equal(s.launchCount(), 0);
  });

  await test(`${shell}: run does nothing without exactly one master in the namespace`, (context) => {
    const s = provisionScene(context);
    s.request();
    const check = (text, pattern) => {
      s.setRecord(text);
      const result = s.run(shell);
      assert.equal(result.code, 0, result.err);
      assert.match(result.err, pattern);
      assert.equal(s.hasStatus(), false);
    };
    check("", /0 blocks with role=master/);
    const worker = masterBlock(s.home, "worker");
    check(`${worker}\n`, /0 blocks with role=master/);
    const second = masterBlock(s.home).replace(/profileId=.*/, `profileId=${ALICE}`);
    check(`${masterBlock(s.home)}\n\n${second}\n`, /2 blocks with role=master/);
    const elsewhere = masterBlock(s.home).replace(`namespace=${NAMESPACE}`, "namespace=other-1");
    check(`${elsewhere}\n`, /0 blocks with role=master/);
  });

  await test(`${shell}: run and status refuse a wrong call`, (context) => {
    const s = provisionScene(context);
    const run = (args) => s.run(shell, {}, args).code;
    assert.equal(run([]), 64);
    assert.equal(run(["fly"]), 64);
    assert.equal(run(["run", s.state, s.record]), 64);
    assert.equal(run(["run", join(s.home, "missing"), s.record, NAMESPACE]), 64);
    assert.equal(run(["run", s.state, "relative", NAMESPACE]), 65);
    assert.equal(run(["run", s.state, s.record, "Bad_1"]), 65);
    assert.equal(run(["status", s.state]), 64);
    assert.equal(run(["status", s.state, "nope"]), 65);
    assert.equal(run(["status", s.state, OPERATION]), 65);
    writeFileSync(join(s.state, "launcher.lock"), "");
    mkdirSync(join(s.state, "ops"), { recursive: true });
    writeFileSync(join(s.state, "ops", OPERATION), "step=nowhere\n");
    assert.equal(run(["status", s.state, OPERATION]), 65);
  });
}
