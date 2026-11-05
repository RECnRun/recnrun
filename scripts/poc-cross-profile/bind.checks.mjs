import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { BOB, EX_NO_ACK, EX_REFUSED, OTHER_TOKEN, UUID, lines, open, scene } from "./open-lab.mjs";

/** `open.sh bind <root> Default <namespace> [mode]` for the scene's root. */
const bindArgs = (root, ...rest) => ["bind", root, "Default", NAMESPACE, ...rest];

for (const shell of shells) {
  await test(`${shell}: bind launches the profile and takes the profile id the ack names`, (context) => {
    const { home, root, argv, env } = scene(context);
    const result = open(shell, bindArgs(root), env({ STUB_PROFILE: BOB }));
    assert.equal(result.code, 0, result.err);
    const [profile, downloads, boot, token] = lines(result.out);
    assert.equal(profile, `profileId=${BOB}`);
    assert.equal(downloads, `root=${home}/Downloads`);
    assert.match(token ?? "", /^token=/);
    assert.match((token ?? "").slice(6), UUID);
    assert.equal(boot, `boot=${(token ?? "").slice(6)}`);
    assert.match(result.err, /pid=\d+/);
    assert.ok(existsSync(argv));
  });

  await test(`${shell}: bind refuses a free argument and never runs Chrome`, (context) => {
    const { root, argv, env } = scene(context);
    const result = open(shell, [...bindArgs(root, "headed"), "--evil"], env());
    assert.equal(result.code, EX_REFUSED, result.err);
    assert.equal(existsSync(argv), false);
  });

  await test(`${shell}: bind refuses a path outside the record grammar and a bad name`, (context) => {
    const { root, argv, env } = scene(context);
    const bad = [
      ["bind", "relative/Chrome", "Default", NAMESPACE],
      ["bind", `${root}/../Chrome`, "Default", NAMESPACE],
      ["bind", `${root}$(id)`, "Default", NAMESPACE],
      ["bind", root, "../Default", NAMESPACE],
      ["bind", root, "Default;id", NAMESPACE],
      ["bind", root, "Default", "Lab_1"],
      ["bind", root, "Default", NAMESPACE, "Headed"],
    ];
    for (const args of bad) assert.equal(open(shell, args, env()).code, EX_REFUSED, args.join(" "));
    assert.equal(existsSync(argv), false);
  });

  await test(`${shell}: bind refuses a profile without Preferences and creates nothing`, (context) => {
    const { root, argv, env } = scene(context);
    rmSync(join(root, "Default/Preferences"));
    assert.equal(open(shell, bindArgs(root), env()).code, EX_REFUSED);
    assert.equal(open(shell, ["bind", root, "Profile 9", NAMESPACE], env()).code, EX_REFUSED);
    assert.equal(existsSync(argv), false);
    assert.equal(existsSync(join(root, "Default/Preferences")), false);
    assert.equal(existsSync(join(root, "Profile 9")), false);
  });

  await test(`${shell}: bind exits 64 on a wrong call`, (context) => {
    const { root, env } = scene(context);
    assert.equal(open(shell, ["bind", root, "Default"], env()).code, 64);
    assert.equal(open(shell, bindArgs(root), env({ RECNRUN_OPEN_TIMEOUT_S: "soon" })).code, 64);
  });

  const ignored = [
    { title: "an ack of another token", extra: { STUB_TOKEN: OTHER_TOKEN } },
    { title: "an ack whose body holds another token", extra: { STUB_BODY_TOKEN: OTHER_TOKEN } },
    { title: "an ack whose body names another profile", extra: { STUB_BODY_PROFILE: BOB } },
    { title: "an ack behind a symbolic link", extra: { STUB_KIND: "symlink" } },
    { title: "an ack in a folder that is no uuid", extra: { STUB_PROFILE: "not-a-profile" } },
    { title: "an ack that does not match the closed grammar", extra: { STUB_SHAPE: "trailing" } },
  ];
  for (const { title, extra } of ignored) {
    await test(`${shell}: bind ignores ${title} and times out listing the roots`, (context) => {
      const { home, root, env } = scene(context);
      const result = open(shell, bindArgs(root), env(extra));
      assert.equal(result.code, EX_NO_ACK, result.err);
      assert.equal(result.out, "");
      assert.ok(result.err.includes(`${home}/Downloads`), result.err);
    });
  }

  await test(`${shell}: bind passes headless and keeps a profile directory with a space whole`, (context) => {
    const { root, argv, env } = scene(context);
    mkdirSync(join(root, "Profile 2"));
    writeFileSync(join(root, "Profile 2/Preferences"), "{}");
    const args = ["bind", root, "Profile 2", NAMESPACE, "headless"];
    assert.equal(open(shell, args, env({ STUB_PROFILE: BOB })).code, 0);
    const words = readFileSync(argv, "utf8").split("\n").slice(0, -1);
    assert.deepEqual(words.slice(0, 3), [
      "--headless=new",
      `--user-data-dir=${root}`,
      "--profile-directory=Profile 2",
    ]);
  });
}
