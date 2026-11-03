import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/test-container.mjs");
const fixture = fileURLToPath(new URL("./docker-fixture.mjs", import.meta.url));

function launch(context, scenario = "success", extra = [], task = "test:e2e:local") {
  const directory = mkdtempSync(join(tmpdir(), "recnrun-container-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  if (scenario !== "missing-cli") {
    writeFileSync(docker, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`);
    chmodSync(docker, 0o755);
  }
  // verify sets the smoke mode in the container; the checks decide it per task themselves.
  const { RECNRUN_EXPERIMENT_SAMPLES: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, [runner, task, ...extra], {
    cwd: directory,
    env: {
      ...inherited,
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

function directoryCopies(calls) {
  return calls.filter(([command, source]) => command === "cp" && source.endsWith("/."));
}

async function imageVersions() {
  const run = promisify(execFile);
  // Inside the test container the image is the current system and Docker is not available.
  if (process.env.RECNRUN_TEST_CONTAINER === "1") {
    const versions = JSON.parse(readFileSync("/opt/recnrun/versions.json", "utf8"));
    return { reported: (await run("google-chrome", ["--version"])).stdout.trim(), versions };
  }
  // The runtime stage holds Chrome without the workspace, so the build reuses Docker's cache.
  const build = ["build", "--quiet", "--target", "runtime", "--file", "Dockerfile.tests", "."];
  const image = (await run("docker", build, { cwd: root, maxBuffer: 1 << 24 })).stdout.trim();
  const version = ["run", "--rm", "--entrypoint", "google-chrome", image, "--version"];
  return { reported: (await run("docker", version)).stdout.trim() };
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

await test("forwards arguments literally and runs the current workspace in an isolated container", async (context) => {
  const grep = "round with spaces; $(touch SHOULD_NOT_EXIST)";
  const result = await launch(context, "success", ["--", "--grep", grep]);
  assert.equal(result.code, 0, result.output);
  const build = result.calls.find(([command]) => command === "build");
  assert.equal(build.at(-1), root.replace(/\/$/, ""));
  const create = result.calls.find(([command]) => command === "create");
  assert.ok(create.includes("--init"));
  assert.ok(create.includes("--shm-size=2g"));
  assert.ok(create.includes(`RECNRUN_RUN_ID=${basename(result.artifacts)}`));
  // The managed-policy install writes /etc only when this marker says it runs in the container.
  assert.ok(create.includes("RECNRUN_TEST_CONTAINER=1"));
  assert.ok(
    result.calls.some(
      ([command, source]) =>
        command === "cp" && source.endsWith(":/workspace/.artifacts/evidence/."),
    ),
  );
  assert.ok(!create.includes("--volume"));
  assert.ok(!create.includes("--publish"));
  assert.deepEqual(create.slice(-4), ["sha256:fixture-image", "test:e2e:local", "--grep", grep]);
  assert.match(
    readFileSync(join(result.artifacts, "run.log"), "utf8"),
    /Container diagnostic output/,
  );
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test("runs the experiments of verify in smoke mode and leaves the experiments task alone", async (context) => {
  const verify = await launch(context, "success", [], "verify:local");
  assert.equal(verify.code, 0, verify.output);
  const verifyCreate = verify.calls.find(([command]) => command === "create");
  assert.ok(verifyCreate.includes("RECNRUN_EXPERIMENT_SAMPLES=smoke"));
  const experiments = await launch(context, "success", [], "test:experiments:local");
  assert.equal(experiments.code, 0, experiments.output);
  const create = experiments.calls.find(([command]) => command === "create");
  assert.ok(!create.some((argument) => argument.startsWith("RECNRUN_EXPERIMENT_SAMPLES=")));
});

const TASKS = [
  "test:local",
  "verify:local",
  "test:unit:local",
  "test:components:local",
  "test:e2e:local",
  "test:browser:local",
  "test:experiments:local",
  "test:headless:local",
  "test:coverage:local",
];

await test("runs every task on the internal recnrun-tests network, never the default or none", async (context) => {
  for (const task of TASKS) {
    const result = await launch(context, "success", [], task);
    assert.equal(result.code, 0, result.output);
    const create = result.calls.find(([command]) => command === "create");
    const networks = create.flatMap((argument, index) =>
      create[index - 1] === "--network" || argument.startsWith("--network=")
        ? [argument]
        : argument === "--net" || argument.startsWith("--net=")
          ? [argument]
          : [],
    );
    assert.deepEqual(networks, ["recnrun-tests"], task);
    // The entry step adds the on-link default route WebRTC needs; it needs this capability.
    assert.equal(create[create.indexOf("--cap-add") + 1], "NET_ADMIN", task);
    const made = result.calls.filter(
      ([command, action]) => command === "network" && action === "create",
    );
    assert.deepEqual(made, [["network", "create", "--internal", "recnrun-tests"]], task);
    assert.ok(!result.calls.some(([command, action]) => command === "network" && action === "rm"));
  }
});

await test("refuses a recnrun-tests network that routes out", async (context) => {
  const result = await launch(context, "external-network");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /recnrun-tests routes out/);
  assert.ok(!result.calls.some(([command]) => command === "create"));
});

await test("refuses the host runner, which drives the installed Google Chrome of the Mac", async (context) => {
  for (const task of ["test:host", "test:host:local"]) {
    const result = await launch(context, "success", [], task);
    assert.equal(result.code, 1, result.output);
    assert.match(
      result.output,
      /test:host runs Google Chrome on the macOS host and never in Docker/,
    );
    assert.deepEqual(result.calls, []);
  }
});

await test("preserves a failing test's exit code and copies evidence before removing the container", async (context) => {
  const result = await launch(context, "test-failure");
  assert.equal(result.code, 7, result.output);
  assert.equal(directoryCopies(result.calls).length, 4);
  for (const artifact of ["coverage", "test-results", "playwright-report", "evidence"]) {
    assert.equal(
      readFileSync(join(result.artifacts, artifact, "evidence.txt"), "utf8"),
      "Test evidence",
    );
  }
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test("records the image's tool versions and id in versions.json", async (context) => {
  const result = await launch(context, "test-failure");
  assert.equal(result.code, 7, result.output);
  const versions = JSON.parse(readFileSync(join(result.artifacts, "versions.json"), "utf8"));
  assert.deepEqual(Object.keys(versions).sort(), ["chrome", "image", "node", "playwright", "pnpm"]);
  assert.equal(versions.image, "sha256:fixture-image");
  assert.match(versions.chrome, /^Google Chrome \d+\./);
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test(
  "the test image ships Google Chrome Stable 156 or later",
  { timeout: 1_800_000 },
  async () => {
    const { reported, versions } = await imageVersions();
    const match = /^Google Chrome (\d+)\.\d+\.\d+\.\d+$/.exec(reported);
    assert.ok(match, `Unexpected google-chrome --version output: ${reported}`);
    assert.ok(Number(match[1]) >= 156, `Google Chrome ${match[1]} is older than 156`);
    if (versions) assert.equal(versions.chrome, reported);
  },
);

await test("reports unavailable Docker without falling back to local browsers", async (context) => {
  const result = await launch(context, "unavailable");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Docker.*available|Docker Desktop/);
  assert.deepEqual(
    result.calls.map(([command]) => command),
    ["info"],
  );
});

await test("does not start tests after a failed image build", async (context) => {
  const result = await launch(context, "build-failure");
  assert.equal(result.code, 3, result.output);
  assert.ok(!result.calls.some(([command]) => command === "create"));
});

await test("reports a missing Docker executable with a normal failure exit code", async (context) => {
  const result = await launch(context, "missing-cli");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Docker is not available/);
  assert.deepEqual(result.calls, []);
});

await test("rejects missing test exit status and still cleans up the container", async (context) => {
  const result = await launch(context, "empty-exit");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /invalid test exit code/);
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test("fails if successful tests cannot export their artifacts", async (context) => {
  const result = await launch(context, "copy-failure");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /artifact/i);
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test("removes the container even if an artifact destination cannot be created", async (context) => {
  const result = await launch(context, "blocked-export");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /artifact/i);
  assert.equal(directoryCopies(result.calls).length, 3);
  assert.equal(result.calls.at(-1)[0], "rm");
});

await test(
  "stops interrupted tests, exports evidence and removes the container",
  { timeout: 10_000 },
  async (context) => {
    const result = await launch(context, "interrupt");
    assert.equal(result.code, 130, result.output);
    assert.ok(result.calls.some(([command]) => command === "stop"));
    assert.equal(directoryCopies(result.calls).length, 4);

    assert.equal(result.calls.at(-1)[0], "rm");
  },
);

await test("public tests route through Docker while local variants and the hooks retain every gate", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const layer of ["unit", "components", "e2e", "browser", "experiments", "coverage"]) {
    assert.equal(
      manifest.scripts[`test:${layer}`],
      `node scripts/test-container.mjs test:${layer}:local`,
    );
    assert.ok(manifest.scripts[`test:${layer}:local`]);
  }
  assert.match(manifest.scripts["test:container"], /runner\.checks\.mjs/);
  assert.equal(
    manifest.scripts["test:coverage:local"],
    "vp test --coverage && node --test scripts/coverage.checks.mjs",
  );
  assert.equal(manifest.scripts.ready, "vp run verify");
  assert.match(
    readFileSync(join(root, ".vite-hooks/pre-commit"), "utf8"),
    /vp staged\nvp check\nvp run --no-cache deps\nvp run --no-cache test:unit\n/,
  );
  assert.equal(readFileSync(join(root, ".vite-hooks/pre-push"), "utf8").trim(), "vp run verify");
});

await test("the Docker image runs the Node major that engines.node requires", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dockerfile = readFileSync(join(root, "Dockerfile.tests"), "utf8");
  const [, dockerNode] = dockerfile.match(/VP_NODE_VERSION=(\d+)\./);
  const [, enginesNode] = manifest.engines.node.match(/^>=(\d+)\.\d+\.\d+$/);
  assert.equal(enginesNode, dockerNode);
});

await test("the Docker image installs the Vite+ version the catalog pins", () => {
  const catalog = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const dockerfile = readFileSync(join(root, "Dockerfile.tests"), "utf8");
  const [, catalogVersion] = catalog.match(/^ {2}vite-plus: (\S+)$/m);
  const [, dockerVersion] = dockerfile.match(/VP_VERSION=(\S+)/);
  assert.equal(dockerVersion, catalogVersion);
});

await test("verify runs Vitest once, under coverage, and keeps test:local for vp run test", () => {
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  const task = (name) => config.match(new RegExp(`"${name}": \\{[^}]*command: \\[([^\\]]*)\\]`))[1];
  const verifyRuns = task("verify:local").match(/test:(?:[a-z0-9]+:)?local/g);
  assert.deepEqual(verifyRuns, [
    "test:coverage:local",
    "test:e2e:local",
    "test:browser:local",
    "test:experiments:local",
  ]);
  assert.deepEqual(task("test:local").match(/test:(?:[a-z0-9]+:)?local/g), [
    "test:unit:local",
    "test:components:local",
    "test:e2e:local",
    "test:browser:local",
    "test:experiments:local",
  ]);
});
