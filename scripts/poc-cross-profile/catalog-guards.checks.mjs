import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALICE,
  EX_DATAERR,
  EX_TEMPFAIL,
  EX_USAGE,
  NAMESPACE,
  announce,
  lab,
  presence,
  readRegistry,
  run,
  script,
  shells,
  start,
  until,
} from "./lab.mjs";

for (const shell of shells) {
  await test(`${shell}: a run that finds the lock held exits 75 and writes nothing`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    announce(rootA, presence(ALICE));
    writeFileSync(join(out, "registry.json"), "previous");
    mkdirSync(join(out, ".catalog.lock"));
    const result = run(shell, [record, NAMESPACE, out]);
    assert.equal(result.code, EX_TEMPFAIL);
    assert.match(result.stderr, /lock/);
    assert.equal(readFileSync(join(out, "registry.json"), "utf8"), "previous");
    assert.ok(existsSync(join(out, ".catalog.lock")), "the loser leaves the holder's lock");
  });

  await test(`${shell}: a second run during the first exits 75; the first then writes`, async (context) => {
    const { home, rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\nroot=r1\n`);
    announce(rootA, presence(ALICE));
    writeFileSync(join(out, "registry.json"), "previous");
    // The first run holds the lock while it waits to read its record from a pipe.
    const pipe = join(home, "record.fifo");
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const first = start(shell, [pipe, NAMESPACE, out]);
    await until(() => existsSync(join(out, ".catalog.lock")));
    const second = run(shell, [record, NAMESPACE, out]);
    assert.equal(second.code, EX_TEMPFAIL);
    assert.equal(readFileSync(join(out, "registry.json"), "utf8"), "previous");
    writeFileSync(pipe, `downloadsRoot=${rootA}\nroot=r1\n`);
    assert.deepEqual(await first.exited, { code: 0, signal: null });
    assert.deepEqual(Object.keys(readRegistry(out).peers), [ALICE]);
    assert.equal(existsSync(join(out, ".catalog.lock")), false);
  });

  await test(`${shell}: a run stopped by SIGTERM releases the lock and leaves no file`, async (context) => {
    const { home, out } = lab(context);
    const pipe = join(home, "record.fifo");
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const running = start(shell, [pipe, NAMESPACE, out]);
    await until(() => existsSync(join(out, ".catalog.lock")));
    const pid = running.child.pid ?? 0;
    assert.ok(pid > 0);
    process.kill(-pid, "SIGTERM");
    const exit = await running.exited;
    assert.ok(exit.code === 143 || exit.signal === "SIGTERM", JSON.stringify(exit));
    assert.deepEqual(readdirSync(out), []);
  });

  await test(`${shell}: refuses a record outside the format with exit 65`, (context) => {
    const { home, rootA, out, record } = lab(context);
    const refused = [
      [`userDataDir=${home}/../etc\nprofileDirectory=Default\n`, /userDataDir/],
      [`userDataDir=${home}/Chrome/..\nprofileDirectory=Default\n`, /userDataDir/],
      [`downloadsRoot=${rootA}/$(id)\n`, /downloadsRoot/],
      [`downloadsRoot=relative\n`, /downloadsRoot/],
      [`downloadsRoot=${rootA}\ncommand=rm\n`, /unknown key/],
      [`downloadsRoot=${rootA}\ndownloadsRoot=${rootA}\n`, /repeated key/],
      [`downloadsRoot=${rootA}\nroot=/tmp\n`, /root/],
      [`downloadsRoot=${rootA}\nroot=r1\n\ndownloadsRoot=${home}\nroot=r1\n`, /r1/],
      [`downloadsRoot=${rootA}\nroot=r1\n\ndownloadsRoot=${rootA}\nroot=r2\n`, /two ids/],
      [`userDataDir=${home}/Chrome\n`, /profileDirectory/],
      [`userDataDir=${home}/Chrome\nprofileDirectory=a/b\n`, /profileDirectory/],
      [`downloadsRoot=${rootA}\nrole=admin\n`, /role/],
      [`role=worker\n`, /names no/],
      [`downloadsRoot ${rootA}\n`, /key=value/],
      [`downloadsRoot=${rootA}\n${"\n".repeat(70_000)}`, /64 KiB/],
    ];
    for (const [text, reason] of refused) {
      writeFileSync(record, text);
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, EX_DATAERR, `${text}: ${result.stderr}`);
      assert.match(result.stderr, reason, text);
      assert.deepEqual(readdirSync(out), [], text);
      assert.equal(readFileSync(record, "utf8"), text);
    }
  });

  await test(`${shell}: refuses a wrong call with exit 64`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    for (const args of [[], [record, NAMESPACE], [record, "../x", out], [record, "A", out]]) {
      assert.equal(run(shell, args).code, EX_USAGE, JSON.stringify(args));
    }
    assert.deepEqual(readdirSync(out), []);
  });
}

await test("the script never evaluates text as shell code", () => {
  const text = readFileSync(script, "utf8");
  assert.ok(text.length > 0, "catalog.sh is empty");
  assert.doesNotMatch(text, /\beval\b/);
  assert.doesNotMatch(text, /^\s*(\.|source)\s/m);
});
