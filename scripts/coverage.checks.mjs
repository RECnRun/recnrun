import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// The denominator is the tree, not coverage.include: a narrowed include must fail, not shrink it.
const SOURCE = ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"];
// The global thresholds average files out; no single file may fall under these.
const FLOOR = { lines: 80, statements: 80, functions: 80, branches: 75 };
const byPath = (a, b) => a.localeCompare(b);

async function configuredExcludes() {
  const { default: config } = await import(new URL("../vite.config.ts", import.meta.url));
  return config.test.coverage.exclude;
}

function readSummary() {
  const path = join(root, "coverage/coverage-summary.json");
  assert.ok(
    globSync(path).length === 1,
    `Missing ${path}: run vp test --coverage first (json-summary reporter)`,
  );
  const summary = JSON.parse(readFileSync(path, "utf8"));
  return Object.entries(summary)
    .filter(([key]) => key !== "total")
    .map(([file, metrics]) => [relative(root, file), metrics])
    .sort(([a], [b]) => byPath(a, b));
}

/** Each file and metric under the floor, as `path: metric pct% < floor%`. */
function underFloor(files) {
  // A file with no executable code (types only, re-exports) reports 0% everywhere; it has nothing to cover.
  return files
    .filter(([, metrics]) => metrics.lines.total > 0)
    .flatMap(([file, metrics]) =>
      Object.entries(FLOOR)
        .filter(([metric, floor]) => metrics[metric].pct < floor)
        .map(([metric, floor]) => `${file}: ${metric} ${metrics[metric].pct}% < ${floor}%`),
    );
}

await test("coverage measures every source file that the configured excludes do not name", async () => {
  const excludes = await configuredExcludes();
  const expected = globSync(SOURCE, { cwd: root })
    .filter((file) => !excludes.some((pattern) => matchesGlob(file, pattern)))
    .sort(byPath);
  assert.ok(expected.length > 0, "no source files found under apps/*/src or packages/*/src");
  assert.deepEqual(
    readSummary().map(([file]) => file),
    expected,
  );
});

await test("every file with executable code meets the per-file coverage floor", () => {
  const offenders = underFloor(readSummary());
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} file metric(s) under the per-file floor:\n${offenders.join("\n")}`,
  );
});
