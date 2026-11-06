import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, NAMESPACE, linkAt, shells } from "./lab.mjs";
import {
  BOB,
  EX_NO_ACK,
  EX_REFUSED,
  EXTENSION,
  OTHER_TOKEN,
  holdChrome,
  UUID,
  lines,
  open,
  request,
  scene,
} from "./open-lab.mjs";

const EX_NOT_FOUND = 66;

for (const shell of shells) {
  await test(`${shell}: a free argument is refused and Chrome never runs`, (context) => {
    const { record, argv, env } = scene(context);
    const result = open(shell, [...request(record, ALICE, "headed"), "--evil"], env());
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.equal(existsSync(argv), false);
  });

  await test(`${shell}: a profile the record does not register is refused`, (context) => {
    const { record, argv, env } = scene(context);
    assert.equal(open(shell, request(record, BOB), env()).code, EX_REFUSED);
    assert.equal(open(shell, request(record, "not-a-uuid"), env()).code, EX_REFUSED);
    assert.equal(
      open(shell, request(record, "11111111-1111-1111-8111-111111111111"), env()).code,
      EX_REFUSED,
    );
    assert.equal(open(shell, ["open", record, "other-ns", ALICE], env()).code, EX_REFUSED);
    assert.equal(open(shell, request(join(record, "missing")), env()).code, EX_REFUSED);
    assert.equal(existsSync(argv), false);
  });

  await test(`${shell}: a registered profile without Preferences is refused and nothing is created`, (context) => {
    const { root, record, argv, env } = scene(context);
    rmSync(join(root, "Default/Preferences"));
    assert.equal(open(shell, request(record), env()).code, EX_REFUSED);
    assert.equal(existsSync(argv), false);
    assert.equal(existsSync(join(root, "Default/Preferences")), false);
  });

  await test(`${shell}: only the first block of an id counts`, (context) => {
    const { root, record, argv, env, block } = scene(context);
    const broken = block(ALICE).replace(`userDataDir=${root}`, `userDataDir=${root}-missing`);
    writeFileSync(record, `${broken}\n\n\n${block(ALICE)}\n`);
    assert.equal(open(shell, request(record), env()).code, EX_REFUSED);
    assert.equal(existsSync(argv), false);
  });

  for (const { running, asked, flags } of [
    { running: "headless", asked: "headed", flags: ["--headless=new"] },
    { running: "headed", asked: "headless", flags: [] },
  ]) {
    await test(`${shell}: a root that runs ${running} refuses ${asked} at once and starts no Chrome`, (context) => {
      const s = scene(context);
      const { root, record, argv, env } = s;
      holdChrome(context, s, ...flags);
      const started = Date.now();
      const result = open(
        shell,
        request(record, ALICE, asked),
        env({ RECNRUN_OPEN_TIMEOUT_S: "20" }),
      );
      assert.equal(result.code, EX_REFUSED, result.err);
      assert.ok(Date.now() - started < 10_000, "refused without waiting for an ack");
      assert.ok(
        result.err.includes(
          `refused: ${root} already runs ${running}; quit it before opening it ${asked}`,
        ),
        result.err,
      );
      assert.equal(existsSync(argv), false);
      assert.equal(result.out, "");
    });

    await test(`${shell}: a root that runs ${running} is opened ${running} as before`, (context) => {
      const s = scene(context);
      const { record, argv, env } = s;
      holdChrome(context, s, ...flags);
      const result = open(shell, request(record, ALICE, running), env());
      assert.equal(result.code, 0, result.err);
      assert.equal(existsSync(argv), true);
    });
  }

  await test(`${shell}: a helper process of the other mode does not count as the running Chrome`, (context) => {
    const s = scene(context);
    const { record, env } = s;
    holdChrome(context, s, "--type=renderer", "--headless=new");
    assert.equal(open(shell, request(record, ALICE, "headed"), env()).code, 0);
  });

  const badRecords = [
    { title: "an unknown key", extra: (block) => `${block}\ncommand=rm` },
    { title: "a repeated key", extra: (block) => `${block}\nrole=master\nrole=worker` },
    {
      title: "a later block that is invalid",
      extra: (block) =>
        `${block}\n\nuserDataDir=relative\nprofileDirectory=Default\nprofileId=${BOB}\nnamespace=${NAMESPACE}`,
    },
    {
      title: "a later block without a profile id",
      extra: (block) =>
        `${block}\n\nuserDataDir=/tmp/x\nprofileDirectory=Default\nnamespace=${NAMESPACE}`,
    },
    {
      title: "a later block without a namespace",
      extra: (block) =>
        `${block}\n\nuserDataDir=/tmp/x\nprofileDirectory=Default\nprofileId=${BOB}`,
    },
  ];
  for (const { title, extra } of badRecords) {
    await test(`${shell}: a record with ${title} is refused before Chrome runs`, (context) => {
      const { record, argv, env, block } = scene(context);
      writeFileSync(record, `${extra(block(ALICE))}\n`);
      const result = open(shell, request(record), env());
      assert.equal(result.code, EX_REFUSED, result.err);
      assert.equal(existsSync(argv), false);
    });
  }

  for (const [title, name] of [
    ["a quote", 'Chrome"quoted'],
    ["a command substitution", "Chrome$(id)"],
    ["a backtick", "Chrome`id`"],
    ["a backslash", "Chrome\\root"],
  ]) {
    await test(`${shell}: a userDataDir with ${title} is refused although the folder exists`, (context) => {
      const { home, record, argv, env, block } = scene(context);
      const root = join(home, name);
      mkdirSync(join(root, "Default"), { recursive: true });
      writeFileSync(join(root, "Default/Preferences"), "{}");
      writeFileSync(
        record,
        `${block(ALICE).replace(/^userDataDir=.*$/m, () => `userDataDir=${root}`)}\n`,
      );
      const result = open(shell, request(record), env());
      assert.equal(result.code, EX_REFUSED, result.err);
      assert.equal(existsSync(argv), false);
    });
  }

  await test(`${shell}: a mode outside headed and headless is refused`, (context) => {
    const { record, argv, env } = scene(context);
    for (const mode of ["", "Headed", "--headless", "headless;id"])
      assert.equal(open(shell, request(record, ALICE, mode), env()).code, EX_REFUSED, mode);
    assert.equal(existsSync(argv), false);
  });

  await test(`${shell}: a wrong call exits 64`, (context) => {
    const { record, env } = scene(context);
    assert.equal(open(shell, [], env()).code, 64);
    assert.equal(open(shell, ["close"], env()).code, 64);
    assert.equal(open(shell, ["open", record], env()).code, 64);
    assert.equal(open(shell, request(record), env({ RECNRUN_OPEN_TIMEOUT_S: "soon" })).code, 64);
    assert.equal(open(shell, request(record), env({ RECNRUN_OPEN_POLL_S: "0" })).code, 64);
  });

  await test(`${shell}: Chrome gets separate flags and a bootstrap URL with the printed token`, (context) => {
    const { root, record, argv, env } = scene(context);
    const result = open(shell, request(record), env());
    assert.equal(result.code, 0, result.err);
    const token =
      lines(result.out)
        .find((line) => line.startsWith("token="))
        ?.slice(6) ?? "";
    assert.match(token, UUID);
    assert.deepEqual(readFileSync(argv, "utf8").split("\n").slice(0, -1), [
      `--user-data-dir=${root}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      `chrome-extension://${EXTENSION}/bootstrap.html#token=${token}`,
    ]);
    assert.match(result.err, /pid=\d+/);
  });

  await test(`${shell}: headless adds one flag and a profile directory with a space stays one word`, (context) => {
    const { home, root, record, argv, env, block } = scene(context);
    mkdirSync(join(root, "Profile 2"));
    writeFileSync(join(root, "Profile 2/Preferences"), "{}");
    writeFileSync(record, `${block(ALICE).replace("=Default", "=Profile 2")}\n`);
    const result = open(shell, request(record, ALICE, "headless"), env());
    assert.equal(result.code, 0, result.err);
    const words = readFileSync(argv, "utf8").split("\n").slice(0, -1);
    assert.deepEqual(words.slice(0, 3), [
      "--headless=new",
      `--user-data-dir=${root}`,
      "--profile-directory=Profile 2",
    ]);
    assert.ok(existsSync(join(home, "Downloads")));
  });

  await test(`${shell}: a good ack gives the root, the boot, and the token`, (context) => {
    const { home, record, env } = scene(context);
    const result = open(shell, request(record), env({ STUB_DELAY: "1" }));
    assert.equal(result.code, 0, result.err);
    const [root, boot, token] = lines(result.out);
    assert.equal(root, `root=${home}/Downloads`);
    assert.match(token ?? "", /^token=/);
    assert.equal(boot, `boot=${(token ?? "").slice(6)}`);
  });

  await test(`${shell}: the root comes from the profile's Preferences when it names one`, (context) => {
    const { home, root, record, env } = scene(context);
    const downloads = join(home, "Elsewhere");
    writeFileSync(
      join(root, "Default/Preferences"),
      JSON.stringify({ download: { default_directory: downloads } }),
    );
    const result = open(shell, request(record), env({ STUB_ROOT: downloads }));
    assert.equal(result.code, 0, result.err);
    assert.equal(lines(result.out)[0], `root=${downloads}`);
  });

  await test(`${shell}: a running session acks its own boot, which differs from the token`, (context) => {
    const { record, env } = scene(context);
    const boot = "55555555-5555-4555-8555-555555555555";
    const result = open(shell, request(record), env({ STUB_BOOT: boot }));
    assert.equal(result.code, 0, result.err);
    const [, bootLine, tokenLine] = lines(result.out);
    assert.equal(bootLine, `boot=${boot}`);
    assert.notEqual(tokenLine, `token=${boot}`);
  });

  await test(`${shell}: open follows the unpacked build: refused while its folder is gone, open again once it is back or moved`, (context) => {
    const { home, root, record, argv, env } = scene(context);
    const build = join(home, "build");
    const settings = (path) =>
      writeFileSync(
        join(root, "Default/Preferences"),
        `{"extensions":{"settings":{"${EXTENSION}":{"path":"${path}","state":1}}}}`,
      );
    mkdirSync(build);
    writeFileSync(join(build, "manifest.json"), "{}");
    settings(build);
    assert.equal(open(shell, request(record), env()).code, 0, "the build is there");
    rmSync(argv);
    renameSync(build, `${build}-away`);
    const gone = open(shell, request(record), env());
    assert.equal(gone.code, EX_NOT_FOUND, gone.err);
    assert.match(gone.err, new RegExp(`unpacked code missing: ${build}\\n`));
    assert.equal(existsSync(argv), false, "Chrome never started");
    renameSync(`${build}-away`, build);
    assert.equal(open(shell, request(record), env()).code, 0, "restored");
    rmSync(argv);
    renameSync(build, `${build}-moved`);
    settings(`${build}-moved`);
    assert.equal(open(shell, request(record), env()).code, 0, "moved, with the new path loaded");
    assert.ok(existsSync(argv));
  });

  for (const [depth, part] of ["RECnRun", "poc", NAMESPACE, "acks", ALICE].entries()) {
    await test(`${shell}: an ack below a linked ${part} is ignored and the wait times out`, (context) => {
      const { home, record, env } = scene(context);
      const components = ["RECnRun", "poc", NAMESPACE, "acks", ALICE];
      mkdirSync(join(home, "Real", ...components), { recursive: true });
      linkAt(join(home, "Downloads"), join(home, "Real"), components, depth);
      const result = open(shell, request(record), env());
      assert.equal(result.code, EX_NO_ACK, result.err);
      assert.equal(result.out, "");
    });
  }

  const ignored = [
    { title: "an ack of another token", extra: { STUB_TOKEN: OTHER_TOKEN } },
    { title: "an ack whose body holds another token", extra: { STUB_BODY_TOKEN: OTHER_TOKEN } },
    { title: "an ack whose body names another profile", extra: { STUB_BODY_PROFILE: BOB } },
    { title: "an ack of another profile", extra: { STUB_PROFILE: BOB } },
    { title: "an ack behind a symbolic link", extra: { STUB_KIND: "symlink" } },
    { title: "an oversize ack", extra: { STUB_KIND: "oversize" } },
    { title: "an ack with a boot that is not a uuid", extra: { STUB_BOOT: "boot" } },
    { title: "an ack whose boot sits inside the identity", extra: { STUB_SHAPE: "nested" } },
    { title: "an ack with bytes after the closing brace", extra: { STUB_SHAPE: "trailing" } },
    { title: "an ack without createdAt", extra: { STUB_SHAPE: "nocreated" } },
    {
      title: "an ack without an identity (only a template ack may omit it)",
      extra: { STUB_SHAPE: "noident" },
    },
    { title: "an ack whose identity holds free values", extra: { STUB_SHAPE: "freeident" } },
  ];
  for (const { title, extra } of ignored) {
    await test(`${shell}: ${title} is ignored and the wait times out listing the roots`, (context) => {
      const { home, record, env } = scene(context);
      const result = open(shell, request(record), env(extra));
      assert.equal(result.code, EX_NO_ACK, result.err);
      assert.equal(result.out, "");
      assert.ok(result.err.includes(`${home}/Downloads`), result.err);
      assert.match(result.err, /pid=\d+/);
    });
  }
}
