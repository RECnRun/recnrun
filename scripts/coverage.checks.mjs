import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// The denominator is the tree, not coverage.include: a narrowed include must fail, not shrink it.
const SOURCE = ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"];
const byPath = (a, b) => a.localeCompare(b);

async function configuredExcludes() {
  const { default: config } = await import(new URL("../vite.config.ts", import.meta.url));
  return config.test.coverage.exclude;
}

function measuredFiles() {
  const path = join(root, "coverage/coverage-summary.json");
  assert.ok(
    globSync(path).length === 1,
    `Missing ${path}: run vp test --coverage first (json-summary reporter)`,
  );
  const summary = JSON.parse(readFileSync(path, "utf8"));
  return Object.keys(summary)
    .filter((key) => key !== "total")
    .map((file) => relative(root, file))
    .sort(byPath);
}

await test("coverage measures every source file that the configured excludes do not name", async () => {
  const excludes = await configuredExcludes();
  const expected = globSync(SOURCE, { cwd: root })
    .filter((file) => !excludes.some((pattern) => matchesGlob(file, pattern)))
    .sort(byPath);
  assert.ok(expected.length > 0, "no source files found under apps/*/src or packages/*/src");
  assert.deepEqual(measuredFiles(), expected);
});
