// Experiment G: the lab in the person's own Chrome, driven from the service worker's console. There
// the worker stops when idle and starts again with empty memory, which Playwright's runs never saw.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import {
  launchLab,
  observed,
  openApp,
  restartExtension as restart,
  sawIdentity,
  signIn,
  ssoSession,
  write,
  writeEvidence,
  writeUnpacked,
} from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

await test("G: after the worker restarts, a switch refuses instead of guessing the identity", async () => {
  const session = await launchLab();
  try {
    await session.lab.configure({ firstIdentity: "A" });
    const app = await openApp(session);
    await write(app.page, "A-1");
    await session.lab.switchTo(app.tabId, "B");
    await write(app.page, "B-1");
    const { lab } = await restart(session);
    await lab.register(APP);
    await lab.configure({ firstIdentity: "A" });
    const outcome = await lab
      .switchTo(app.tabId, "A")
      .then((receipt) => receipt.kind)
      .catch((error) => String(error.message ?? error));
    await app.page.reload();
    const after = await observed(app.page);
    const captures = await lab.captures();
    evidence.restart = { outcome, captures };
    console.log(JSON.stringify({ restart: evidence.restart }));
    assert.match(outcome, /lost track of http:\/\/app\.localhost:4330's identity/);
    assert.ok(sawIdentity(after, "B-1"), "the tab still holds B");
    assert.deepEqual(captures, ["A"]);
  } finally {
    await session.close();
  }
});

const rec = (worker, command, ...args) =>
  worker.evaluate(([name, values]) => globalThis.rec[name](...values), [command, args]);

await test("G: preset.json configures the lab at every start, and rec switches the group", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
  writeUnpacked({ url: `${APP}/sso-app`, cookieHosts: ["sso.localhost"] }, dir);
  const session = await launchLab({ extension: dir });
  const steps = {};
  evidence.preset = steps;
  try {
    const page = await session.context.newPage();
    await page.goto(`${APP}/sso-app`);
    steps.a = await signIn(page, "alice");
    steps.start = await rec(session.worker, "start");
    steps.toB = await rec(session.worker, "switch", "B");
    steps.b = await ssoSession(page);
    steps.bSignedIn = await signIn(page, "bob");
    steps.toA = await rec(session.worker, "switch", "A");
    steps.backToA = await ssoSession(page);
    // A restart re-applies the preset and refuses, rather than starting over as the first identity.
    const { worker } = await restart(session);
    steps.afterRestart = await rec(worker, "switch", "B").catch((error) => String(error.message));
    assert.equal(steps.start, "RECnRun · A");
    assert.deepEqual(steps.b, { login: true });
    assert.deepEqual(steps.backToA, { user: "alice", profile: "alice" });
    assert.equal(steps.toB.tabs, 1);
    assert.deepEqual(steps.toA.cookies, { removed: 1, set: 1, expired: 0 });
    assert.match(steps.afterRestart, /lost track/);
  } finally {
    console.log(JSON.stringify({ preset: steps }));
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await fixture.close();
writeEvidence("experiment-g", evidence);
