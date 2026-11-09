import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";
import {
  launcherScene,
  markedLauncher,
  masterKey,
  pairedLauncher,
  statusOf,
  submit,
  waitFor,
} from "./launcher-lab.mjs";

const now = () => Math.floor(Date.now() / 1000);
const codeOf = (s, rid) => statusOf(s, rid).code;
const consumed = (s) => readFileSync(join(s.state, "consumed"), "utf8").split("\n");

async function stop(run) {
  process.kill(run.pid, "SIGINT");
  assert.equal(await run.exited, 130, run.err);
}

/** Request fields or text changes that each must end in one status code.
 * @returns {Promise<Array<[string, Record<string, unknown>, string]>>} */
async function refusals(s) {
  const forger = await masterKey();
  const flip = (text) =>
    text.replace(/^(attempt=.*)(.)$/m, (_, head, last) => head + (last === "a" ? "b" : "a"));
  return [
    ["a forged signature", { signer: forger.pair }, "BAD_SIGNATURE"],
    ["a byte changed after signing", { mutate: flip }, "BAD_SIGNATURE"],
    ["an expiry in the past", { expires: now() - 10 }, "EXPIRED"],
    ["an expiry beyond two minutes", { expires: now() + 600 }, "EXPIRED"],
    ["another launcher session", { session: "0123456789abcdef" }, "LAUNCHER_RESTARTED"],
    ["another workspace", { workspace: randomUUID() }, "BAD_FORMAT"],
    [
      "a duplicated line",
      { mutate: (t) => t.replace("root=w1\n", "action=start\n") },
      "BAD_FORMAT",
    ],
    ["an extra line", { mutate: (t) => `${t}extra=1\n` }, "BAD_FORMAT"],
    ["a shell command in a field", { root: `w1;touch ${join(s.home, "pwned")}` }, "BAD_FORMAT"],
    ["a leading-zero expiry", { expires: `0${now() + 60}` }, "BAD_FORMAT"],
    ["an offer that does not match", { offer: "0".repeat(64) }, "BAD_FORMAT"],
    ["more than 1024 bytes", { mutate: (t) => t + "x".repeat(1100) }, "BAD_FORMAT"],
  ];
}

for (const shell of shells) {
  await test(`${shell}: a valid request is accepted once and its replay refused`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    const sent = await submit(s, p);
    await waitFor(() => statusOf(s, sent.rid).state === "accepted");
    const status = statusOf(s, sent.rid);
    assert.deepEqual([status.request, status.session, status.code], [sent.rid, p.session, "none"]);
    assert.ok(!existsSync(join(s.ws, `requests/${sent.rid}.req`)));
    assert.ok(!existsSync(join(s.ws, `exchange/w1/offer-${sent.attempt}.json`)));
    assert.ok(consumed(s).includes(sent.rid));
    writeFileSync(join(s.ws, `exchange/w1/offer-${sent.attempt}.json`), sent.offerBytes);
    writeFileSync(join(s.ws, `requests/${sent.rid}.req`), sent.text);
    await waitFor(() => codeOf(s, sent.rid) === "REPLAY");
    assert.equal(statusOf(s, sent.rid).state, "failed");
    await stop(p.run);
  });

  await test(`${shell}: each malformed or untrusted request gets its code`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    const cases = [];
    for (const [name, f, code] of await refusals(s))
      cases.push({ name, code, ...(await submit(s, p, f)) });
    const target = join(s.home, "target.req");
    writeFileSync(target, (await submit(s, p, { rid: randomUUID() })).text);
    const linked = randomUUID();
    symlinkSync(target, join(s.ws, `requests/${linked}.req`));
    cases.push({ name: "a symbolic link", code: "BAD_FORMAT", rid: linked });
    writeFileSync(join(s.ws, "requests/not-a-request.req"), "x\n");
    const swap = join(s.ws, `requests/${randomUUID()}.req.crswap`);
    writeFileSync(swap, "partial");
    for (const c of cases) {
      await waitFor(() => codeOf(s, c.rid) !== undefined);
      assert.equal(codeOf(s, c.rid), c.code, c.name);
      assert.equal(statusOf(s, c.rid).state, "failed", c.name);
    }
    await waitFor(() => !existsSync(join(s.ws, "requests/not-a-request.req")));
    assert.ok(existsSync(target), "the link is removed, not its target");
    assert.ok(existsSync(swap), "a Chrome swap file is left alone");
    assert.ok(!existsSync(join(s.home, "pwned")), "no field is ever run");
    assert.deepEqual(readdirSync(join(s.state, "claims")), []);
    await stop(p.run);
  });

  await test(`${shell}: a request before pairing is NOT_PAIRED`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await markedLauncher(s);
    const sent = await submit(s, p);
    await waitFor(() => codeOf(s, sent.rid) === "NOT_PAIRED");
    await stop(p.run);
  });

  await test(`${shell}: a claim left by a killed launcher is LAUNCHER_RESTARTED`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    await stop(p.run);
    const rid = randomUUID();
    mkdirSync(join(s.state, "claims", rid));
    writeFileSync(join(s.ws, `requests/${rid}.req`), "left behind\n");
    const run = s.start();
    await waitFor(() => codeOf(s, rid) === "LAUNCHER_RESTARTED");
    assert.ok(!existsSync(join(s.ws, `requests/${rid}.req`)));
    assert.deepEqual(readdirSync(join(s.state, "claims")), []);
    await stop(run);
  });

  await test(`${shell}: one tick reads at most eight requests`, async (context) => {
    const s = launcherScene(context, shell);
    mkdirSync(join(s.ws, "requests"), { recursive: true });
    for (let i = 0; i < 10; i += 1)
      writeFileSync(join(s.ws, `requests/${randomUUID()}.req`), "x\n");
    const run = s.start(undefined, { RECNRUN_LAB_TICK_S: "3" });
    const statuses = () =>
      existsSync(join(s.ws, "status")) ? readdirSync(join(s.ws, "status")).length : 0;
    await waitFor(() => statuses() >= 8);
    await delay(500);
    assert.equal(statuses(), 8);
    await waitFor(() => statuses() === 10);
    await stop(run);
  });
}
