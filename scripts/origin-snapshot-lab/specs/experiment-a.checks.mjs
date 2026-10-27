// Experiment A: does the application's first script read the restored state?
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFixture } from "../fixture/server.mjs";
import {
  brief,
  launchLab,
  observed,
  openApp,
  sawIdentity,
  stats,
  writeEvidence,
  write,
} from "../lab.mjs";

const RUNS = Number(process.env.ORIGIN_LAB_RUNS ?? 50);
const results = [];
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

/** A, B, then RUNS resumes alternating A and B; each turn checks the first reads, then writes. */
async function series({ candidate, delayMs, path, replace = true }) {
  fixture.state.observations.length = 0;
  fixture.state.requests.length = 0;
  const session = await launchLab();
  await session.lab.configure({ candidate, delayMs, replace });
  const { page, tabId } = await openApp(session, path);
  const expected = { A: null, B: null };
  const turns = [];
  try {
    for (let index = 0; index < RUNS + 2; index += 1) {
      const identity = index % 2 === 0 ? "A" : "B";
      const receipt = await session.lab.switchTo(tabId, identity);
      const seen = await observed(page);
      const ok = sawIdentity(seen, expected[identity]);
      turns.push({ identity, kind: receipt.kind, ok, ms: receipt.ms, seen: brief(seen) });
      expected[identity] = `${identity}-${index}`;
      await write(page, expected[identity]);
    }
  } catch (error) {
    turns.push({ error: String(error?.message ?? error) });
  } finally {
    await session.close();
  }
  const resumes = turns.filter((turn) => turn.kind === "resume");
  const result = {
    candidate,
    delayMs,
    path,
    replace,
    version: session.version,
    resumes: resumes.length,
    failures: resumes.filter((turn) => !turn.ok).length,
    errors: turns.filter((turn) => turn.error).map((turn) => turn.error),
    observerRanInGate: fixture.state.observations.filter((o) => o.href.includes("__recnrun_gate"))
      .length,
    gateRequestsReachingServer: fixture.state.requests.filter((r) =>
      r.search.includes("__recnrun_gate"),
    ).length,
    switchMs: stats(resumes.map((turn) => turn.ms)),
    firstFailures: resumes.filter((turn) => !turn.ok).slice(0, 3),
  };
  results.push(result);
  console.log(JSON.stringify({ ...result, firstFailures: result.firstFailures.length }));
  return result;
}

for (const delayMs of [0, 2000]) {
  await test(`A0 restores in the app's own document (negative control), delay ${delayMs} ms`, async () => {
    const result = await series({ candidate: "a0", delayMs, path: "/app" });
    if (delayMs > 0) assert.ok(result.failures > 0, "the delayed restore should lose the race");
  });

  for (const path of ["/app", "/app?sw=1"]) {
    await test(`A1 gate document, delay ${delayMs} ms, ${path}`, async () => {
      const result = await series({ candidate: "a1", delayMs, path });
      assert.deepEqual(result.errors, []);
      assert.equal(result.resumes, RUNS);
      assert.equal(result.failures, 0);
      assert.equal(result.observerRanInGate, 0);
    });

    await test(`A1 gate document with tabs.update (history kept), delay ${delayMs} ms, ${path}`, async () => {
      const result = await series({ candidate: "a1", delayMs, path, replace: false });
      assert.equal(result.failures, 0);
      assert.equal(result.observerRanInGate, 0);
    });

    await test(`A2 CSP header on the gate document, delay ${delayMs} ms, ${path}`, async () => {
      await series({ candidate: "a2", delayMs, path });
    });
  }
}

await fixture.close();
writeEvidence("experiment-a", { runs: RUNS, results });
