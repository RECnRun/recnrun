import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";
import { launcherScene, masterKey, waitFor } from "./launcher-lab.mjs";

const ALLOW = ["--allow", "http://127.0.0.1:4600"];
const offered = (s) => join(s.ws, "pairing/master.spki");
const gone = (s) => () => !existsSync(offered(s));

/** Starts the launcher and, once it beats, writes the master key the way the site does. */
async function started(s, args, spki) {
  const run = s.start(args);
  await waitFor(() => s.heartbeat().seq !== undefined);
  if (spki) writeFileSync(offered(s), spki);
  return run;
}

async function stop(run) {
  process.kill(run.pid, "SIGINT");
  assert.equal(await run.exited, 130, run.err);
}

for (const shell of shells) {
  await test(`${shell}: --pair with the site's fingerprint pairs the master`, async (context) => {
    const s = launcherScene(context, shell);
    const { spki, fp } = await masterKey();
    const run = await started(s, [...ALLOW, "--pair", fp], spki);
    await waitFor(() => s.heartbeat().paired === fp);
    assert.ok(!existsSync(offered(s)), "the workspace copy is consumed");
    assert.deepEqual(readFileSync(join(s.state, "master.spki")), spki);
    assert.match(readFileSync(join(s.state, "master.pem"), "utf8"), /BEGIN PUBLIC KEY/);
    await waitFor(() => run.out.includes(`paired=${fp}\n`));
    await stop(run);
  });

  await test(`${shell}: an empty master.spki is one Chrome still writes`, async (context) => {
    const s = launcherScene(context, shell);
    const { spki, fp } = await masterKey();
    const run = await started(s, [...ALLOW, "--pair", fp], Buffer.alloc(0));
    const seq = Number(s.heartbeat().seq);
    await waitFor(() => Number(s.heartbeat().seq) >= seq + 2);
    assert.ok(existsSync(offered(s)), "the empty file is left for the site to fill");
    writeFileSync(offered(s), spki);
    await waitFor(() => s.heartbeat().paired === fp);
    await stop(run);
  });

  await test(`${shell}: --pair with another fingerprint rejects the key`, async (context) => {
    const s = launcherScene(context, shell);
    const { spki } = await masterKey();
    const other = await masterKey();
    const run = await started(s, [...ALLOW, "--pair", other.fp], spki);
    await waitFor(() => s.heartbeat().paired === "rejected");
    assert.ok(!existsSync(offered(s)));
    assert.ok(!existsSync(join(s.state, "master.pem")));
    await stop(run);
  });

  await test(`${shell}: a key that is not a 91-byte P-256 SPKI is deleted unread`, async (context) => {
    const s = launcherScene(context, shell);
    const { spki, fp } = await masterKey();
    const run = await started(s, [...ALLOW, "--pair", fp]);
    const wrongPrefix = Buffer.from(spki);
    wrongPrefix[3] ^= 1;
    for (const bytes of [Buffer.concat([spki, Buffer.from([0])]), wrongPrefix]) {
      writeFileSync(offered(s), bytes);
      await waitFor(gone(s));
    }
    assert.equal(s.heartbeat().paired, "none");
    assert.ok(!existsSync(join(s.state, "master.spki")));
    await stop(run);
  });

  await test(`${shell}: a changed master key is refused and the old one stays`, async (context) => {
    const s = launcherScene(context, shell);
    const first = await masterKey();
    const second = await masterKey();
    const run = await started(s, [...ALLOW, "--pair", first.fp], first.spki);
    await waitFor(() => s.heartbeat().paired === first.fp);
    await stop(run);
    const next = await started(s, [...ALLOW, "--pair", second.fp]);
    writeFileSync(offered(s), second.spki);
    await waitFor(gone(s));
    await waitFor(() => next.err.includes("rm state/master.spki state/master.pem state/paired"));
    assert.equal(s.heartbeat().paired, first.fp);
    assert.deepEqual(readFileSync(join(s.state, "master.spki")), first.spki);
    await stop(next);
  });

  await test(`${shell}: without --pair and without a terminal the key is refused`, async (context) => {
    const s = launcherScene(context, shell);
    const { spki } = await masterKey();
    const run = await started(s, ALLOW, spki);
    await waitFor(() => s.heartbeat().paired === "rejected");
    assert.ok(!existsSync(offered(s)));
    assert.ok(!existsSync(join(s.state, "master.pem")));
    assert.match(run.err, /--pair/);
    await stop(run);
  });
}
