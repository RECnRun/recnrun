import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALICE,
  BOB,
  CAROL,
  BOOT,
  EX_USAGE,
  IDENTITY,
  NAMESPACE,
  PEER_BOOT,
  announce,
  lab,
  normalized,
  peerOf,
  presence,
  publish,
  readRegistry,
  run,
  sample,
  shells,
} from "./lab.mjs";

// Shaped like a uuid with no hex digit, or not a v4: neither may reach registry.json.
const HYPHENS = "-".repeat(36);
const HYPHEN_BOOT = "--------------4----8----------------";
const V1 = "11111111-1111-1111-8111-111111111111";
// One past Number.MAX_SAFE_INTEGER, written as the digits JSON.stringify gives it.
const timeOver = (key) =>
  JSON.stringify(presence(BOB)).replace(new RegExp(`"${key}":[0-9]+`), `"${key}":9007199254740992`);

// The table registry.test.ts holds RegistrationNameSchema to.
const displayNames = JSON.parse(
  readFileSync(new URL("./fixtures/display-names.json", import.meta.url), "utf8"),
);
const DAY = 86_400_000;
/** Bob's registration with its identity statement changed, or dropped as `identity: undefined`. */
function signed(change) {
  const identity = "identity" in change ? change.identity : { ...IDENTITY, ...change };
  return JSON.stringify(presence(BOB, { identity }));
}
/** Bob's registration with its times offset from now, so it is not yet expired. */
function freshness({ createdAt = 0, expiresAt = createdAt + 60_000 }) {
  const now = Date.now();
  return JSON.stringify(presence(BOB, { createdAt: now + createdAt, expiresAt: now + expiresAt }));
}

for (const shell of shells) {
  await test(`${shell}: catalogs two roots under two ids and writes the ids back`, (context) => {
    const { home, rootA, rootB, out, record } = lab(context);
    const recordText = [
      `userDataDir=${home}/Chrome`,
      "profileDirectory=Default",
      `profileId=${ALICE}`,
      `namespace=${NAMESPACE}`,
      "role=master",
      `downloadsRoot=${rootA}`,
      "",
      `downloadsRoot=${rootB}`,
      "",
    ].join("\n");
    writeFileSync(record, recordText);
    announce(rootA, presence(ALICE, { displayName: "José's Mac" }));
    announce(rootB, presence(BOB));
    const before = Date.now();
    assert.deepEqual(run(shell, [record, NAMESPACE, out]), { code: 0, stderr: "" });
    const registry = normalized(readRegistry(out), before);
    assert.deepEqual(registry, {
      version: 1,
      namespace: NAMESPACE,
      writtenAt: 1_800_000_000_500,
      launcher: { boot: BOOT },
      roots: { r1: rootA, r2: rootB },
      peers: {
        [ALICE]: { ...peerOf(ALICE, "r1"), displayName: "José's Mac" },
        [BOB]: peerOf(BOB, "r2"),
      },
    });
    assert.deepEqual(Object.keys(registry), [
      "version",
      "namespace",
      "writtenAt",
      "launcher",
      "roots",
      "peers",
    ]);
    const written = readFileSync(record, "utf8");
    assert.equal(
      written,
      recordText
        .replace(`${rootA}\n`, `${rootA}\nroot=r1\n`)
        .replace(`${rootB}\n`, `${rootB}\nroot=r2\n`),
    );
    const portable = JSON.stringify(registry, null, 2).replaceAll(home, "/tmp/recnrun-catalog");
    sample("registry.sample.json", `${portable}\n`);
    sample("launcher.sample.record", written.replaceAll(home, "/tmp/recnrun-catalog"));
    assert.deepEqual(run(shell, [record, NAMESPACE, out]), { code: 0, stderr: "" });
    assert.equal(readFileSync(record, "utf8"), written, "a second run keeps the ids");
    assert.deepEqual(readdirSync(out), ["registry.json"]);
  });

  await test(`${shell}: keeps the root ids the record names and numbers the others`, (context) => {
    const { rootA, rootB, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootB}\n\ndownloadsRoot=${rootA}\nroot=r1\n`);
    announce(rootA, presence(ALICE));
    announce(rootB, presence(BOB));
    assert.equal(run(shell, [record, NAMESPACE, out]).code, 0);
    const { peers } = readRegistry(out);
    assert.deepEqual([peers[ALICE].root, peers[BOB].root], ["r1", "r2"]);
    assert.equal(
      readFileSync(record, "utf8"),
      `downloadsRoot=${rootB}\nroot=r2\n\ndownloadsRoot=${rootA}\nroot=r1\n`,
    );
  });

  await test(`${shell}: keeps the newer presence of a profile found in two roots`, (context) => {
    const { rootA, rootB, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n\ndownloadsRoot=${rootB}\n`);
    const first = presence(ALICE);
    announce(rootA, first);
    announce(rootB, presence(ALICE, { createdAt: first.createdAt + 1 }));
    assert.equal(run(shell, [record, NAMESPACE, out]).code, 0);
    assert.deepEqual(Object.keys(readRegistry(out).peers), [ALICE]);
    assert.equal(readRegistry(out).peers[ALICE].root, "r2");
  });

  await test(`${shell}: stamps a fresh v4 boot unless the launcher passes its own`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    const boots = new Set();
    for (let index = 0; index < 3; index += 1) {
      assert.equal(run(shell, [record, NAMESPACE, out], {}).code, 0);
      boots.add(readRegistry(out).launcher.boot);
    }
    assert.equal(boots.size, 3);
    for (const boot of boots) {
      assert.match(boot, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.equal(
      run(shell, [record, NAMESPACE, out], { RECNRUN_LAUNCHER_BOOT: "x" }).code,
      EX_USAGE,
    );
  });

  await test(`${shell}: holds at most 32 peers`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    for (let index = 0; index < 33; index += 1) {
      announce(rootA, presence(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    }
    const result = run(shell, [record, NAMESPACE, out]);
    assert.equal(result.code, 0);
    assert.equal(Object.keys(readRegistry(out).peers).length, 32);
    assert.match(result.stderr, /at most 32 peers/);
  });

  await test(`${shell}: skips every file that is not exactly an extension's presence`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    const good = presence(ALICE);
    announce(rootA, good);
    const text = JSON.stringify(presence(BOB));
    const skipped = [
      ["not-a-profile", text, "presence.json", /not a profile id/],
      [BOB.toUpperCase().replaceAll("2", "B"), text, "presence.json", /not a profile id/],
      [BOB, `${text.slice(0, -1)},"path":"/Users/me/Downloads"}`, "presence.json", /after boot/],
      [BOB, JSON.stringify(presence(BOB), null, 1), "presence.json", /expected/],
      [BOB, JSON.stringify({ displayName: "Desk", ...presence(BOB) }), "presence.json", /expected/],
      [BOB, JSON.stringify(presence(BOB, { displayName: 'a"b' })), "presence.json", /displayName/],
      [
        BOB,
        JSON.stringify(presence(BOB, { displayName: "x".repeat(65) })),
        "presence.json",
        /displayName/,
      ],
      [
        BOB,
        JSON.stringify(presence(BOB, { displayName: " Desk" })),
        "presence.json",
        /displayName/,
      ],
      [
        BOB,
        JSON.stringify(presence(BOB, { fingerprint: "ab:cd" })),
        "presence.json",
        /fingerprint/,
      ],
      [BOB, signed({ identity: undefined }), "presence.json", /expected ","identity"/],
      [BOB, signed({ key: "B".repeat(86) }), "presence.json", /invalid identity key/],
      [BOB, signed({ key: `${"B".repeat(86)}+` }), "presence.json", /invalid identity key/],
      [BOB, signed({ signedAt: 1.5 }), "presence.json", /invalid identity signedAt/],
      [BOB, signed({ signedAt: -1 }), "presence.json", /invalid identity signedAt/],
      [BOB, timeOver("signedAt"), "presence.json", /invalid identity signedAt/],
      [BOB, signed({ signature: "S".repeat(87) }), "presence.json", /invalid identity signature/],
      [
        BOB,
        signed({ signature: `${"S".repeat(85)}=` }),
        "presence.json",
        /invalid identity signature/,
      ],
      [BOB, signed({ role: "master" }), "presence.json", /expected "},"createdAt"/],
      [BOB, JSON.stringify(presence(BOB, { createdAt: 1.5 })), "presence.json", /createdAt/],
      [BOB, freshness({ createdAt: -10_000, expiresAt: -5_000 }), "presence.json", /expired/],
      [BOB, `${text}\n`, "presence.json", /exact bytes/],
      [BOB, JSON.stringify(presence(CAROL)), "presence.json", /folder/],
      [
        BOB,
        JSON.stringify(presence(BOB, { namespace: undefined, boot: undefined })),
        "presence.json",
        /expected ,"namespace"/,
      ],
      [BOB, JSON.stringify(presence(BOB, { namespace: "lab-2" })), "presence.json", /namespace/],
      [BOB, JSON.stringify(presence(BOB, { boot: "not-a-uuid" })), "presence.json", /boot/],
      [
        BOB,
        JSON.stringify(presence(BOB, { boot: PEER_BOOT.toUpperCase().replaceAll("5", "A") })),
        "presence.json",
        /boot/,
      ],
      [HYPHENS, JSON.stringify(presence(HYPHENS)), "presence.json", /not a profile id/],
      [V1, JSON.stringify(presence(V1)), "presence.json", /not a profile id/],
      [BOB, JSON.stringify(presence(BOB, { boot: HYPHEN_BOOT })), "presence.json", /boot/],
      [BOB, timeOver("createdAt"), "presence.json", /invalid createdAt/],
      [BOB, timeOver("expiresAt"), "presence.json", /invalid expiresAt/],
      [BOB, freshness({ createdAt: DAY }), "presence.json", /ahead of this clock/],
      [BOB, freshness({ expiresAt: 7 * DAY }), "presence.json", /longer than 60000 ms/],
      [
        BOB,
        freshness({ createdAt: 3000, expiresAt: 2000 }),
        "presence.json",
        /not after createdAt/,
      ],
      [BOB, "x".repeat(4096), "presence.json", /bytes/],
      [BOB, text, "registration.json", /no presence.json/],
    ];
    for (const [folder, content, name, reason] of skipped) {
      rmSync(join(rootA, "RECnRun/poc", NAMESPACE, "peers", folder), {
        recursive: true,
        force: true,
      });
      publish(rootA, folder, content, name);
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, 0, `${folder}/${name}: ${result.stderr}`);
      assert.match(result.stderr, /^catalog\.sh: skipped r1\//m, `${folder}: ${content}`);
      assert.match(result.stderr, reason, `${folder}: ${content}`);
      assert.deepEqual(Object.keys(readRegistry(out).peers), [ALICE], `${folder}: ${content}`);
      rmSync(join(rootA, "RECnRun/poc", NAMESPACE, "peers", folder), {
        recursive: true,
        force: true,
      });
    }
  });

  await test(`${shell}: lists exactly the display names RegistrationNameSchema accepts`, (context) => {
    const { rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    for (const { name, accepted } of displayNames) {
      announce(rootA, presence(BOB, { displayName: name }));
      const result = run(shell, [record, NAMESPACE, out]);
      assert.equal(result.code, 0, result.stderr);
      const listed = readRegistry(out).peers[BOB]?.displayName;
      assert.equal(
        listed,
        accepted ? name : undefined,
        `${JSON.stringify(name)}: ${result.stderr}`,
      );
    }
  });

  await test(`${shell}: follows no symbolic link into or out of a peers folder`, (context) => {
    const { home, rootA, out, record } = lab(context);
    writeFileSync(record, `downloadsRoot=${rootA}\n`);
    const elsewhere = publish(home, ALICE, JSON.stringify(presence(ALICE)));
    mkdirSync(join(rootA, "RECnRun/poc", NAMESPACE, "peers"), { recursive: true });
    symlinkSync(elsewhere, join(rootA, "RECnRun/poc", NAMESPACE, "peers", ALICE));
    const linked = join(rootA, "RECnRun/poc", NAMESPACE, "peers", BOB);
    mkdirSync(linked);
    symlinkSync(join(elsewhere, "presence.json"), join(linked, "presence.json"));
    const result = run(shell, [record, NAMESPACE, out]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /skipped r1\/1111.*not a folder/);
    assert.match(result.stderr, /skipped r1\/2222.*no presence.json/);
    assert.deepEqual(readRegistry(out).peers, {});
  });
}
