import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/test-container.mjs");
const fixture = fileURLToPath(new URL("./docker-fixture.mjs", import.meta.url));

function launch(context, scenario = "success", extra = []) {
  const directory = mkdtempSync(join(tmpdir(), "recnrun-container-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  if (scenario !== "missing-cli") {
    writeFileSync(docker, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`);
    chmodSync(docker, 0o755);
  }
  const child = spawn(process.execPath, [runner, "test:e2e:local", ...extra], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: scenario === "missing-cli" ? directory : `${directory}${delimiter}${process.env.PATH}`,
      DOCKER_FIXTURE_DIR: directory,
      DOCKER_FIXTURE_SCENARIO: scenario,
      RECNRUN_TEST_CONTAINER: "",
      RECNRUN_TEST_ARTIFACTS: join(directory, "artifacts"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
    if (scenario === "interrupt" && output.includes("Container test output")) {
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (data) => (output += data));
  return new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const calls = readCalls(directory);
      const build = calls.find(([command]) => command === "build");
      const artifacts = build && resolve(build[build.indexOf("--iidfile") + 1], "..");
      done({ code, calls, output, artifacts });
    });
  });
}

function readCalls(directory) {
  try {
    return readFileSync(join(directory, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("forwards arguments literally and runs the current workspace in an isolated container", async (context) => {
  const grep = "round with spaces; $(touch SHOULD_NOT_EXIST)";
  const result = await launch(context, "success", ["--", "--grep", grep]);
  assert.equal(result.code, 0, result.output);
  const build = result.calls.find(([command]) => command === "build");
  assert.equal(build.at(-1), root.replace(/\/$/, ""));
  const create = result.calls.find(([command]) => command === "create");
  assert.ok(create.includes("--init"));
  assert.ok(create.includes("--shm-size=2g"));
  assert.ok(!create.includes("--volume"));
  assert.ok(!create.includes("--publish"));
  assert.deepEqual(create.slice(-4), ["sha256:fixture-image", "test:e2e:local", "--grep", grep]);
  assert.match(
    readFileSync(join(result.artifacts, "run.log"), "utf8"),
    /Container diagnostic output/,
  );
  assert.equal(result.calls.at(-1)[0], "rm");
});

test("preserves a failing test's exit code and copies evidence before removing the container", async (context) => {
  const result = await launch(context, "test-failure");
  assert.equal(result.code, 7, result.output);
  const copies = result.calls.filter(([command]) => command === "cp");
  assert.equal(copies.length, 3);
  for (const artifact of ["coverage", "test-results", "playwright-report"]) {
    assert.equal(
      readFileSync(join(result.artifacts, artifact, "evidence.txt"), "utf8"),
      "Test evidence",
    );
  }
  assert.equal(result.calls.at(-1)[0], "rm");
});

test("reports unavailable Docker without falling back to local browsers", async (context) => {
  const result = await launch(context, "unavailable");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Docker.*available|Docker Desktop/);
  assert.deepEqual(
    result.calls.map(([command]) => command),
    ["info"],
  );
});

test("does not start tests after a failed image build", async (context) => {
  const result = await launch(context, "build-failure");
  assert.equal(result.code, 3, result.output);
  assert.ok(!result.calls.some(([command]) => command === "create"));
});

test("reports a missing Docker executable with a normal failure exit code", async (context) => {
  const result = await launch(context, "missing-cli");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Docker is not available/);
  assert.deepEqual(result.calls, []);
});

test("rejects missing test exit status and still cleans up the container", async (context) => {
  const result = await launch(context, "empty-exit");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /invalid test exit code/);
  assert.equal(result.calls.at(-1)[0], "rm");
});

test("fails if successful tests cannot export their artifacts", async (context) => {
  const result = await launch(context, "copy-failure");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /artifact/i);
  assert.equal(result.calls.at(-1)[0], "rm");
});

test("removes the container even if an artifact destination cannot be created", async (context) => {
  const result = await launch(context, "blocked-export");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /artifact/i);
  assert.equal(result.calls.filter(([command]) => command === "cp").length, 2);
  assert.equal(result.calls.at(-1)[0], "rm");
});

test(
  "stops interrupted tests, exports evidence and removes the container",
  { timeout: 10_000 },
  async (context) => {
    const result = await launch(context, "interrupt");
    assert.equal(result.code, 130, result.output);
    assert.ok(result.calls.some(([command]) => command === "stop"));
    assert.equal(result.calls.filter(([command]) => command === "cp").length, 3);
    assert.equal(result.calls.at(-1)[0], "rm");
  },
);

test("public tests route through Docker while local variants and the hooks retain every gate", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const layer of ["unit", "components", "e2e", "coverage"]) {
    assert.equal(
      manifest.scripts[`test:${layer}`],
      `node scripts/test-container.mjs test:${layer}:local`,
    );
    assert.ok(manifest.scripts[`test:${layer}:local`]);
  }
  assert.match(manifest.scripts["test:container"], /runner\.checks\.mjs/);
  assert.equal(manifest.scripts.ready, "vp run verify");
  assert.match(
    readFileSync(join(root, ".vite-hooks/pre-commit"), "utf8"),
    /vp staged\nvp check\nvp run --no-cache deps\nvp run --no-cache test:unit\n/,
  );
  assert.equal(readFileSync(join(root, ".vite-hooks/pre-push"), "utf8").trim(), "vp run verify");
});

test("verify runs Vitest once, under coverage, and keeps test:local for vp run test", () => {
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  const task = (name) => config.match(new RegExp(`"${name}": \\{[^}]*command: \\[([^\\]]*)\\]`))[1];
  const verifyRuns = task("verify:local").match(/test:(?:[a-z0-9]+:)?local/g);
  assert.deepEqual(verifyRuns, ["test:coverage:local", "test:e2e:local"]);
  assert.deepEqual(task("test:local").match(/test:(?:[a-z0-9]+:)?local/g), [
    "test:unit:local",
    "test:components:local",
    "test:e2e:local",
  ]);
});
