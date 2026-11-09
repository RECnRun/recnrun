import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";
import { launcherScene, pairedLauncher, statusOf, submit, waitFor } from "./launcher-lab.mjs";

const workers = (s) =>
  existsSync(join(s.home, "launches.txt"))
    ? readFileSync(join(s.home, "launches.txt"), "utf8")
        .split("\n")
        .filter((line) => line === "worker").length
    : 0;
const answerOf = (s, attempt) => join(s.ws, `exchange/w1/answer-${attempt}.json`);

/** A paired launcher whose worker answers as `mode` says, and one request sent to it. */
async function deliver(context, shell, mode) {
  const s = launcherScene(context, shell);
  const p = await pairedLauncher(s, { extra: { STUB_WORKER_ANSWER: mode } });
  const sent = await submit(s, p);
  await waitFor(() => ["answered", "refused"].includes(statusOf(s, sent.rid).state), 30_000);
  return { s, p, sent, status: statusOf(s, sent.rid) };
}

async function stop(run) {
  process.kill(run.pid, "SIGINT");
  assert.equal(await run.exited, 130, run.err);
}

for (const shell of shells) {
  await test(`${shell}: the worker's answer is copied out and the request answered`, async (context) => {
    const { s, p, sent, status } = await deliver(context, shell, "answer");
    assert.deepEqual([status.state, status.code], ["answered", "-"], p.run.err);
    const answer = readFileSync(answerOf(s, sent.attempt), "utf8");
    assert.equal(answer, `{"type":"answer","attempt":"${sent.attempt}"}`);
    assert.deepEqual(readdirSync(join(s.ws, "exchange/w1")), [`answer-${sent.attempt}.json`]);
    assert.deepEqual(readdirSync(join(s.root, "ext/exchange")), []);
    assert.equal(workers(s), 1);
    await stop(p.run);
  });

  await test(`${shell}: an answer beside its .crdownload is not copied yet`, async (context) => {
    const { s, p, sent, status } = await deliver(context, shell, "crdownload");
    assert.equal(status.state, "answered", p.run.err);
    assert.match(readFileSync(answerOf(s, sent.attempt), "utf8"), /"type":"answer"/);
    await stop(p.run);
  });

  await test(`${shell}: an oversize answer is NO_ANSWER and never copied`, async (context) => {
    const { s, p, sent, status } = await deliver(context, shell, "oversize");
    assert.deepEqual([status.state, status.code], ["refused", "NO_ANSWER"]);
    assert.ok(!existsSync(answerOf(s, sent.attempt)));
    await stop(p.run);
  });

  await test(`${shell}: no answer relaunches the worker once, then NO_ANSWER`, async (context) => {
    const { s, p, status } = await deliver(context, shell, "never");
    assert.deepEqual([status.code, workers(s)], ["NO_ANSWER", 2]);
    await stop(p.run);
  });

  await test(`${shell}: a worker that answers only once relaunched is answered`, async (context) => {
    const { s, p, sent, status } = await deliver(context, shell, "late");
    assert.deepEqual([status.state, workers(s)], ["answered", 2]);
    assert.ok(existsSync(answerOf(s, sent.attempt)));
    await stop(p.run);
  });

  await test(`${shell}: a linked worker is BUSY and never relaunched`, async (context) => {
    const { s, p, status } = await deliver(context, shell, "linked");
    assert.deepEqual([status.code, workers(s)], ["BUSY", 1]);
    await stop(p.run);
  });
}
