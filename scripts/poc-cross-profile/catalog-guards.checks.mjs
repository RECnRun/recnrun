import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALICE,
  BOOT,
  EX_CANTCREAT,
  EX_DATAERR,
  EX_TEMPFAIL,
  EX_USAGE,
  NAMESPACE,
  announce,
  publish,
  lab,
  presence,
  readRegistry,
  run,
  script,
  shells,
  start,
  until,
} from "./lab.mjs";

/** Opens and closes the pipe for writing if a reader waits on it; does nothing otherwise. */
function release(pipe) {
  try {
    closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // ENXIO: no reader holds the pipe open.
  }
}

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
    // A reader forked just after the signal still waits on the pipe, and the shell defers its
    // trap until that reader ends, so an empty writer is offered until the run exits.
    let exit;
    void running.exited.then((value) => {
      exit = value;
    });
    await until(() => {
      release(pipe);
      return exit !== undefined;
    });
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
      // Command substitution would drop the NUL and accept /safetail.
      ["downloadsRoot=/safe\0tail\n", /byte other than/],
      [`downloadsRoot=${rootA}\r\n`, /byte other than/],
      [`downloadsRoot=${home}/caf\u00e9\n`, /byte other than/],
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

  await test(`${shell}: follows no symbolic link at RECnRun, poc, or the namespace`, (context) => {
    const { home, rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    publish(join(home, "elsewhere"), ALICE, JSON.stringify(presence(ALICE)));
    const parts = ["RECnRun", "poc", NAMESPACE];
    for (const [index, part] of parts.entries()) {
      const above = join(rootA, ...parts.slice(0, index));
      mkdirSync(above, { recursive: true });
      symlinkSync(join(home, "elsewhere", ...parts.slice(0, index + 1)), join(above, part));
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, 0, `${part}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`skipped r1: ${part} is a symbolic link`), part);
      assert.deepEqual(readRegistry(out).peers, {}, part);
      rmSync(join(above, part));
      if (index < parts.length - 1) mkdirSync(join(above, part));
    }
  });

  await test(`${shell}: never writes through a link planted at a temporary name`, (context) => {
    const { home, rootA, out, record } = lab(context);
    const recordText = `downloadsRoot=${rootA}\n`;
    writeFileSync(record, recordText);
    announce(rootA, presence(ALICE));
    const outside = join(home, "outside");
    writeFileSync(outside, "kept");
    // exec keeps the pid, so the links sit at the names a run derived from $$ would use.
    const planted = spawnSync(
      shell,
      [
        "-c",
        'ln -s "$1" "$3/registry.json.tmp.$$" && ln -s "$1" "$2.tmp.$$" && exec "$0" "$4" "$2" "$5" "$3"',
        shell,
        outside,
        record,
        out,
        script,
        NAMESPACE,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, RECNRUN_LAUNCHER_BOOT: BOOT } },
    );
    assert.equal(planted.status, 0, planted.stderr);
    assert.equal(readFileSync(outside, "utf8"), "kept");
    assert.deepEqual(Object.keys(readRegistry(out).peers), [ALICE]);
    assert.equal(readFileSync(record, "utf8"), `${recordText}root=r1\n`);
  });

  await test(`${shell}: refuses a temporary name that already exists with exit 73`, (context) => {
    const { home, rootA, out, record } = lab(context);
    const recordText = `downloadsRoot=${rootA}\n`;
    writeFileSync(record, recordText);
    announce(rootA, presence(ALICE));
    const outside = join(home, "outside");
    writeFileSync(outside, "kept");
    // An od that always gives the same bytes makes the run's random names known in advance.
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "od"), "#!/bin/sh\nprintf ' 01 23 45 67 89 ab cd ef\\n'\n", {
      mode: 0o755,
    });
    const env = { PATH: `${bin}:${process.env.PATH}`, RECNRUN_LAUNCHER_BOOT: BOOT };
    for (const name of [
      `${record}.0123456789abcdef.tmp`,
      join(out, "registry.json.0123456789abcdef.tmp"),
    ]) {
      symlinkSync(outside, name);
      const result = spawnSync(shell, [script, record, NAMESPACE, out], { encoding: "utf8", env });
      assert.equal(result.status, EX_CANTCREAT, result.stderr);
      assert.equal(readFileSync(outside, "utf8"), "kept", name);
      assert.match(result.stderr, /temporary name .* is taken/);
      assert.equal(existsSync(join(out, "registry.json")), false, name);
      assert.equal(readFileSync(record, "utf8"), recordText, name);
      rmSync(name);
    }
  });

  await test(`${shell}: refuses a registry.json that is a folder or a link with exit 73`, (context) => {
    const { home, rootA, out, record } = lab(context);
    const recordText = `downloadsRoot=${rootA}\n`;
    writeFileSync(record, recordText);
    announce(rootA, presence(ALICE));
    mkdirSync(join(home, "folder"));
    for (const make of [
      () => mkdirSync(join(out, "registry.json")),
      () => symlinkSync(join(home, "folder"), join(out, "registry.json")),
    ]) {
      make();
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, EX_CANTCREAT, result.stderr);
      assert.match(result.stderr, /registry\.json/);
      assert.deepEqual(readdirSync(join(out, "registry.json")), []);
      assert.equal(readFileSync(record, "utf8"), recordText, "the record is left as it was");
      rmSync(join(out, "registry.json"), { recursive: true });
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

// The libraries catalog.sh sources by a fixed name next to itself, and nothing else.
const LIBRARIES = ["record.sh", "presence.sh"];
const libraryPath = (name) => new URL(name, `file://${script}`);

await test("the script never evaluates text as shell code", () => {
  for (const path of [script, ...LIBRARIES.map(libraryPath)]) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.length > 0, `${path} is empty`);
    assert.doesNotMatch(text, /\beval\b/);
  }
  const sourced = readFileSync(script, "utf8").match(/^\s*(?:\.|source)\s.*$/gm);
  assert.deepEqual(
    sourced,
    LIBRARIES.map((name) => `. "$here/${name}"`),
  );
});

/** The value of `const <name> = <digits> [* <digits>]...;` in a TypeScript source. */
function constantIn(path, name) {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const match = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(text);
  assert.ok(match, `${name} in ${path}`);
  return match[1]
    .split("*")
    .reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}

await test("the script's freshness bounds are the extension's constants", () => {
  const text = readFileSync(libraryPath("presence.sh"), "utf8");
  const shellValue = (name) => Number(new RegExp(`^${name}=([0-9]+)$`, "m").exec(text)?.[1]);
  assert.equal(
    shellValue("clock_skew_ms"),
    constantIn("apps/extension/src/p2p/downloads-rendezvous.ts", "CLOCK_SKEW_MS"),
  );
  assert.equal(
    shellValue("presence_ttl_ms"),
    constantIn("apps/extension/src/p2p/folder-rendezvous.ts", "PRESENCE_TTL_MS"),
  );
});
