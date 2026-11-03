import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decide,
  readVerdicts,
  REPORT,
  START,
  END,
  unmappedVerdicts,
  unmatchedRows,
  writeReport,
} from "./decide.mjs";
import { MAPPING, NOT_MAPPED, SPECS } from "./decide-mapping.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./decide.mjs", import.meta.url));
const committed = readVerdicts(repository).map((entry) => entry.verdict);
const chrome = "Google Chrome 156.0.8078.79";

function verdict(experiment, hypothesis, status, extra = {}) {
  return { experiment, hypothesis, verdict: status, chrome, samples: 1, ...extra };
}

function tree(context, files) {
  const root = mkdtempSync(join(tmpdir(), "recnrun-decide-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "docs", "poc", "namespace-sessions", "experiments", "verdicts");
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    writeFileSync(join(directory, name), text);
  }
  return root;
}

function run(root, ...flags) {
  const result = spawnSync(process.execPath, [script, root, ...flags], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr.trim() };
}

const squash = (text) => text.replace(/ +/g, " ");
const pair = [
  { experiment: "E2", hypothesis: "a", capability: "page", route: "A", reason: "r1" },
  { experiment: "E2", hypothesis: "b", capability: "page", route: "C", reason: "r2" },
];

test("maps no hypothesis that the committed verdicts lack", () => {
  assert.ok(committed.length > 0);
  assert.deepEqual(unmatchedRows(committed, MAPPING), []);
});

test("maps every committed verdict or names its experiment as not mapped", () => {
  const left = unmappedVerdicts(committed, MAPPING);
  assert.ok(left.length > 0);
  assert.deepEqual(
    [...new Set(left.map((entry) => entry.experiment))].sort((a, b) => a.localeCompare(b)),
    Object.keys(NOT_MAPPED).sort((a, b) => a.localeCompare(b)),
  );
});

test("cites an existing spec for every experiment", () => {
  for (const experiment of new Set(committed.map((entry) => entry.experiment))) {
    assert.ok(existsSync(join(repository, SPECS[experiment] ?? "missing")), experiment);
  }
});

test("prints one pass and one fail in their capability and route cells", (context) => {
  const root = tree(context, {
    "E2.json": [verdict("E2", "a", "pass"), verdict("E2", "b", "fail")],
  });
  const out = squash(decide(root, pair));
  assert.match(out, /\| page \| pass \(1\) \| not tested \| fail \(1\) \|/);
  assert.match(out, /\| shared \| not tested \| not tested \| not tested \|/);
  assert.match(out, /\| Route A \| 1 \| 0 \| 0 \| 0 \| 7 \|/);
  assert.match(out, /\| Route C \| 0 \| 0 \| 1 \| 0 \| 7 \|/);
  assert.match(out, /Chrome: Google Chrome 156\.0\.8078\.79 \(2 verdicts\)/);
});

test("shows a cell that mixes a pass and a fail as mixed, and skips diagnostics", (context) => {
  const root = tree(context, {
    "E2.json": [
      verdict("E2", "a", "pass"),
      verdict("E2", "b", "fail"),
      verdict("E2", "c", "fail", { label: "diagnostic" }),
    ],
  });
  const rows = [...pair.map((row) => ({ ...row, route: "A" })), { ...pair[0], hypothesis: "c" }];
  const out = squash(decide(root, rows));
  assert.match(out, /\| page \| mixed \(1 pass, 1 fail\) \|/);
  assert.match(out, /\| page \| A \| E2 c \| fail \(diagnostic\) \|/);
});

test("judges a variant group by its variants", (context) => {
  const variants = [
    { name: "sw-x", verdict: "pass" },
    { name: "sw-y", verdict: "fail" },
    { name: "dedicated-x", verdict: "pass" },
  ];
  const root = tree(context, { "E2.json": [verdict("E2", "a", "fail", { variants })] });
  const rows = [
    { ...pair[0], variant: "sw-*", capability: "serviceWorker.first" },
    { ...pair[0], variant: "dedicated-*", capability: "dedicated" },
  ];
  const out = squash(decide(root, rows));
  assert.match(out, /\| dedicated \| pass \(1\) \|/);
  assert.match(out, /\| serviceWorker.first \| fail \(1\) \|/);
});

test("lists unmapped verdicts and fails on a row whose verdict is missing", (context) => {
  const root = tree(context, {
    "E2.json": [verdict("E2", "a", "pass"), verdict("E2", "z", "pass")],
  });
  assert.match(
    squash(decide(root, pair.slice(0, 1))),
    /\| E2 \| 1 \| 1 \| 0 \| 0 \| no mapping row \|/,
  );
  assert.throws(() => decide(root, pair), /E2\/b matches no verdict/);
});

test("says the stress run is not recorded, then summarizes it", (context) => {
  const root = tree(context, { "E2.json": [verdict("E2", "a", "pass")] });
  assert.match(decide(root, pair.slice(0, 1)), /stress: not recorded/);
  const stress = {
    iterations: 7,
    requested: 7,
    failedIterations: [],
    perHypothesis: { "E3/x": { pass: 7, fail: 0, unavailable: 0, lateAttaches: 0 } },
  };
  writeFileSync(
    join(root, "docs/poc/namespace-sessions/experiments/verdicts/stress.json"),
    JSON.stringify(stress),
  );
  const out = squash(decide(root, pair.slice(0, 1)));
  assert.match(out, /stress: 7 of 7 iterations, 0 failed/);
  assert.match(out, /\| E3\/x \| 7 \| 0 \| 0 \| 0 \|/);
});

test("refuses a smoke verdict and names its file", (context) => {
  const root = tree(context, { "E2.json": [verdict("E2", "a", "pass", { mode: "smoke" })] });
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.err, /verdicts\/E2\.json.*smoke/);
});

test("fails on malformed input and names the file", (context) => {
  const cases = {
    "E2.json": "{not json",
    "E3.json": [{ experiment: "E3", hypothesis: "a", verdict: "maybe", chrome, samples: 1 }],
    "E4.json": [verdict("E5", "a", "pass")],
  };
  for (const [name, content] of Object.entries(cases)) {
    const root = tree(context, { [name]: content });
    const result = run(root);
    assert.equal(result.code, 1, name);
    assert.ok(result.err.includes(`verdicts/${name}`), result.err);
  }
});

test("prints the same output on the command line as from decide()", () => {
  const result = run(repository);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, `${decide(repository)}\n`);
});

test("writeReport replaces the block between the markers and leaves the rest", (context) => {
  const root = tree(context, { "E2.json": [verdict("E2", "a", "pass")] });
  const report = join(root, REPORT);
  writeFileSync(report, `Before.\n\n${START}\nold\n${END}\n\nAfter.\n`);
  writeReport(root, pair.slice(0, 1));
  const text = readFileSync(report, "utf8");
  assert.equal(text, `Before.\n\n${START}\n${decide(root, pair.slice(0, 1))}\n${END}\n\nAfter.\n`);
});
