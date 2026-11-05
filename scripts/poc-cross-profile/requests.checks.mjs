import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALICE, NAMESPACE, shells } from "./lab.mjs";

const script = fileURLToPath(new URL("./open.sh", import.meta.url));
const EX_REFUSED = 65;
const EX_NO_ACK = 69;
const BOB = "22222222-2222-4222-8222-222222222222";
const OTHER_TOKEN = "99999999-9999-4999-8999-999999999999";
const EXTENSION = readFileSync(new URL("./extension-id", import.meta.url), "utf8").trim();
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Records its argv and, when STUB_ROOT is set, writes an ack for the token in its URL after a delay.
const STUB = `#!/bin/sh
KEY=${"B".repeat(87)}
SIG=${"S".repeat(86)}
for a in "$@"; do last=$a; done
printf '%s\\n' "$@" >"$STUB_ARGV"
[ -n "\${STUB_ROOT:-}" ] || exit 0
sleep "\${STUB_DELAY:-1}"
token=\${STUB_TOKEN:-\${last#*token=}}
boot=\${STUB_BOOT:-$token}
ident='{"key":"'$KEY'","signedAt":1,"signature":"'$SIG'"}'
head='{"token":"'\${STUB_BODY_TOKEN:-$token}'","profileId":"'\${STUB_BODY_PROFILE:-$STUB_PROFILE}'","identity":'
case \${STUB_SHAPE:-good} in
  good) body=$head$ident',"boot":"'$boot'","createdAt":1}' ;;
  trailing) body=$head$ident',"boot":"'$boot'","createdAt":1}x' ;;
  nocreated) body=$head$ident',"boot":"'$boot'"}' ;;
  nested) body=$head'{"key":"'$KEY'","signedAt":1,"signature":"'$SIG'","boot":"'$boot'"},"createdAt":1}' ;;
  freeident) body=$head'{"key":"K","signedAt":1,"signature":"S"},"boot":"'$boot'","createdAt":1}' ;;
esac
dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
mkdir -p "$dir"
case \${STUB_KIND:-good} in
  good) printf '%s' "$body" >"$dir/$token.json" ;;
  symlink) printf '%s' "$body" >"$STUB_ROOT/real.json"; ln -s "$STUB_ROOT/real.json" "$dir/$token.json" ;;
  oversize) { printf '%s' "$body"; head -c 5000 /dev/zero | tr '\\0' ' '; } >"$dir/$token.json" ;;
esac
`;

function open(shell, args, env) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const lines = (text) => text.split("\n").filter((line) => line !== "");

/** A temporary home with a stub Chrome, one registered profile, and the environment to run in. */
function scene(context, { blocks } = {}) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-open-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Chrome");
  const argv = join(home, "argv.txt");
  const chrome = join(home, APP);
  mkdirSync(join(chrome, ".."), { recursive: true });
  writeFileSync(chrome, STUB);
  chmodSync(chrome, 0o755);
  mkdirSync(join(root, "Default"), { recursive: true });
  writeFileSync(join(root, "Default/Preferences"), "{}");
  const record = join(home, "launcher.record");
  const block = (id, extra = []) =>
    [
      `userDataDir=${root}`,
      "profileDirectory=Default",
      `profileId=${id}`,
      `namespace=${NAMESPACE}`,
      ...extra,
    ].join("\n");
  writeFileSync(record, `${blocks ?? block(ALICE)}\n`);
  const env = (extra = {}) => ({
    HOME: home,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    RECNRUN_OPEN_TIMEOUT_S: "2",
    STUB_ARGV: argv,
    STUB_ROOT: join(home, "Downloads"),
    STUB_NS: NAMESPACE,
    STUB_PROFILE: ALICE,
    STUB_DELAY: "0",
    ...extra,
  });
  return { home, root, record, argv, env, block };
}
const request = (record, id = ALICE, ...rest) => ["open", record, NAMESPACE, id, ...rest];

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
