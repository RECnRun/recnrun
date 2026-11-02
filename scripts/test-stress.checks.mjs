import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = join(root, "scripts/test-stress.mjs");
const evidence = join(root, ".artifacts/evidence");
const cycle = ["baseline", "net-delay", "cpu-load", "cold", "warm", "switch-early", "switch-late"];

// Records one verdict per hypothesis for the condition the runner chose; no browser needed.
const taggedSpec = `import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("records the stress condition @order-critical", () => {
  const condition = process.env.RECNRUN_STRESS_CONDITION;
  if (process.env.STRESS_CHECK_THROW === condition) throw new Error("the spec broke");
  const verdict = process.env.STRESS_CHECK_FAIL === condition ? "fail" : "pass";
  const directory = join(process.cwd(), ".artifacts/evidence", process.env.RECNRUN_RUN_ID);
  mkdirSync(directory, { recursive: true });
  const common = { experiment: "S1", condition, runId: process.env.RECNRUN_RUN_ID };
  const order = { ...common, hypothesis: "order", verdict, lateAttaches: verdict === "fail" ? 2 : 0 };
  order.cpuThreads = process.env.RECNRUN_STRESS_CPU_THREADS ?? null;
  const marker = { ...common, hypothesis: "marker", verdict: "unavailable", firstEffectBeforeMarker: 1 };
  writeFileSync(join(directory, "verdicts.json"), JSON.stringify([order, marker]));
});

test("is untagged and must not run", () => {
  throw new Error("an untagged test ran");
});
`;
const untaggedSpec = `import { test } from "@playwright/test";

test("is untagged and must not run", () => {
  throw new Error("an untagged test ran");
});
`;

function project(context, spec) {
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  // Inside the repository so the spec resolves @playwright/test from its node_modules.
  const directory = mkdtempSync(join(root, ".artifacts/stress-checks-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "playwright.config.mjs"), 'export default { testDir: "." };\n');
  writeFileSync(join(directory, "throwaway.spec.mjs"), spec);
  return join(directory, "playwright.config.mjs");
}

function stress(context, args, env = {}) {
  const run = `stress-checks-${randomUUID()}`;
  context.after(() => rmSync(join(evidence, run), { recursive: true, force: true }));
  const environment = { ...process.env, RECNRUN_RUN_ID: run, ...env };
  if (!("RECNRUN_STRESS_ITERATIONS" in env)) delete environment.RECNRUN_STRESS_ITERATIONS;
  const child = spawn(process.execPath, [runner, ...args], { cwd: root, env: environment });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  return new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) => done({ code, output, run, directory: join(evidence, run) }));
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function eightIterations(context) {
  const tagged = project(context, taggedSpec);
  const untagged = project(context, untaggedSpec);
  return stress(context, ["--iterations", "8", "--config", tagged, "--config", untagged]);
}

test("runs the tagged specs once per iteration and cycles the conditions", async (context) => {
  const result = await eightIterations(context);
  assert.equal(result.code, 0, result.output);
  const labels = [...cycle, "baseline"].map((condition, index) => `${index + 1}-${condition}`);
  assert.deepEqual(readdirSync(join(result.directory, "stress")).sort(), [...labels].sort());
  for (const [index, label] of labels.entries()) {
    const condition = cycle[index % cycle.length];
    const [order] = readJson(join(result.directory, "stress", label, "verdicts.json"));
    assert.equal(order.condition, condition);
    assert.equal(order.runId, `${result.run}/stress/${label}`);
    assert.equal(order.cpuThreads !== null, condition === "cpu-load", label);
  }
  assert.match(result.output, /cpu-load \(\d+ busy threads\)/);

  const summary = readJson(join(result.directory, "stress.json"));
  assert.equal(summary.iterations, 8);
  assert.deepEqual(summary.conditions, {
    baseline: 2,
    "net-delay": 1,
    "cpu-load": 1,
    cold: 1,
    warm: 1,
    "switch-early": 1,
    "switch-late": 1,
  });
  assert.equal(summary.specs.length, 1);
  assert.match(
    summary.specs[0],
    /throwaway\.spec\.mjs.*records the stress condition @order-critical/,
  );
  assert.deepEqual(summary.perHypothesis, {
    "S1/order": { pass: 8, fail: 0, unavailable: 0, lateAttaches: 0 },
    "S1/marker": { pass: 0, fail: 0, unavailable: 8, lateAttaches: 8 },
  });
  assert.deepEqual(summary.failedIterations, []);
  assert.match(result.output, /S1\/order +pass 8 +fail 0/);
});

test("exits non-zero and names the iteration when a hypothesis records a fail", async (context) => {
  const tagged = project(context, taggedSpec);
  const env = { RECNRUN_STRESS_ITERATIONS: "2", STRESS_CHECK_FAIL: "net-delay" };
  const result = await stress(context, ["--config", tagged], env);
  assert.equal(result.code, 1, result.output);
  const summary = readJson(join(result.directory, "stress.json"));
  assert.equal(summary.iterations, 2);
  assert.deepEqual(summary.perHypothesis["S1/order"], {
    pass: 1,
    fail: 1,
    unavailable: 0,
    lateAttaches: 2,
  });
  assert.deepEqual(summary.failedIterations, [
    {
      iteration: 2,
      condition: "net-delay",
      runId: `${result.run}/stress/2-net-delay`,
      failures: ["S1/order: fail"],
    },
  ]);
});

test("counts an iteration whose spec failed as a failed iteration", async (context) => {
  const tagged = project(context, taggedSpec);
  const env = { STRESS_CHECK_THROW: "baseline" };
  const result = await stress(context, ["--iterations", "1", "--config", tagged], env);
  assert.equal(result.code, 1, result.output);
  const summary = readJson(join(result.directory, "stress.json"));
  assert.equal(summary.failedIterations.length, 1);
  assert.match(summary.failedIterations[0].failures[0], /playwright\.config\.mjs exited 1/);
});

test("fails with a clear message when no spec is tagged @order-critical", async (context) => {
  const untagged = project(context, untaggedSpec);
  const result = await stress(context, ["--config", untagged]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /100 iterations/);
  assert.match(result.output, /No Playwright test is tagged @order-critical/);
  assert.ok(!existsSync(join(result.directory, "stress.json")));
});

test("rejects an iteration count that is not a positive integer", async (context) => {
  const result = await stress(context, ["--iterations", "0"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /--iterations must be a positive integer/);
});
