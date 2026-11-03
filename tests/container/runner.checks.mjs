import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/test-container.mjs");
const fixture = fileURLToPath(new URL("./docker-fixture.mjs", import.meta.url));

function launch(context, scenario = "success", extra = [], options = {}) {
  const { task = "test:e2e:local", script = runner, env = {} } = options;
  const directory = mkdtempSync(join(tmpdir(), "recnrun-container-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  if (scenario !== "missing-cli") {
    writeFileSync(docker, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`);
    chmodSync(docker, 0o755);
  }
  const child = spawn(process.execPath, [script, task, ...extra], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: scenario === "missing-cli" ? directory : `${directory}${delimiter}${process.env.PATH}`,
      DOCKER_FIXTURE_DIR: directory,
      DOCKER_FIXTURE_SCENARIO: scenario,
      RECNRUN_TEST_CONTAINER: "",
      RECNRUN_TEST_ARTIFACTS: join(directory, "artifacts"),
      ...env,
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

async function chromeVersion() {
  const run = promisify(execFile);
  // Inside the test container the image is the current system and Docker is not available.
  if (process.env.RECNRUN_TEST_CONTAINER === "1") {
    return (await run("google-chrome", ["--version"])).stdout.trim();
  }
  const build = ["build", "--quiet", "--target", "runtime", "--file", "Dockerfile.tests", "."];
  const image = (await run("docker", build, { cwd: root })).stdout.trim();
  const version = ["run", "--rm", "--entrypoint", "google-chrome", image, "--version"];
  return (await run("docker", version)).stdout.trim();
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
  assert.match(result.output, /^Build step 1$/m);
});

test("quiet mode streams nothing and ends with the artifacts, exit code, and test output tail", async (context) => {
  const result = await launch(context, "test-failure", [], { env: { RECNRUN_TEST_QUIET: "1" } });
  assert.equal(result.code, 7, result.output);
  assert.doesNotMatch(result.output, /^Build step 1$/m);
  assert.match(readFileSync(join(result.artifacts, "run.log"), "utf8"), /^Build step 1$/m);
  const header = `Artifacts: ${result.artifacts}\nExit code: 7\n`;
  assert.ok(result.output.includes(header), result.output);
  // The tail is the build and test output only, never the cleanup calls' exit code or name.
  const tail = result.output.slice(result.output.indexOf(header) + header.length).trimEnd();
  const lines = tail.split("\n");
  assert.equal(lines.length, 20, tail);
  assert.deepEqual(
    lines.slice(0, 18),
    Array.from({ length: 18 }, (_, index) => `Build step ${index + 13}`),
  );
  assert.deepEqual(lines.slice(18).toSorted(), [
    "Container diagnostic output",
    "Container test output",
  ]);
});

test("preserves a failing test's exit code and copies evidence before removing the container", async (context) => {
  const result = await launch(context, "test-failure");
  assert.equal(result.code, 7, result.output);
  assert.equal(directoryCopies(result.calls).length, 3);
  for (const artifact of ["coverage", "test-results", "playwright-report"]) {
    assert.equal(
      readFileSync(join(result.artifacts, artifact, "evidence.txt"), "utf8"),
      "Test evidence",
    );
  }
  assert.equal(result.calls.at(-1)[0], "rm");
});

test("records the image's tool versions and id in versions.json", async (context) => {
  const result = await launch(context, "test-failure");
  assert.equal(result.code, 7, result.output);
  const versions = JSON.parse(readFileSync(join(result.artifacts, "versions.json"), "utf8"));
  assert.deepEqual(Object.keys(versions).sort(), ["chrome", "image", "node", "playwright", "pnpm"]);
  assert.equal(versions.image, "sha256:fixture-image");
  assert.match(versions.chrome, /^Google Chrome \d+\./);
  assert.equal(result.calls.at(-1)[0], "rm");
});

// A clean Git checkout holding the runner, so verify:local can record its marker there.
function checkout(context) {
  const repo = mkdtempSync(join(tmpdir(), "recnrun-checkout-"));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "scripts"));
  for (const file of ["test-container.mjs", "verified-commit.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(repo, "scripts", file));
  }
  writeFileSync(join(repo, ".gitignore"), ".artifacts/\n");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Checks",
    "-c",
    "user.email=checks@recnrun.invalid",
    "commit",
    "-qm",
    "Start",
  );
  return { repo, head: git("rev-parse", "HEAD"), script: join(repo, "scripts/test-container.mjs") };
}

test("a passing verify on a clean checkout records its run id for the commit", async (context) => {
  const { repo, head, script } = checkout(context);
  const env = { RECNRUN_TEST_ARTIFACTS: join(repo, ".artifacts/docker") };
  const result = await launch(context, "success", [], { task: "verify:local", script, env });
  assert.equal(result.code, 0, result.output);
  const marker = readFileSync(join(repo, ".artifacts/verified", head), "utf8").trim();
  assert.equal(marker, basename(result.artifacts));
});

test("a failing, dirty, or dirtied verify records no marker", async (context) => {
  for (const [scenario, dirty] of [
    ["test-failure", false],
    ["success", true],
    ["dirty-during", false],
  ]) {
    const { repo, script } = checkout(context);
    if (dirty) writeFileSync(join(repo, "notes.txt"), "Uncommitted");
    const env = { DOCKER_FIXTURE_TOUCH: join(repo, "touched.txt") };
    const result = await launch(context, scenario, [], { task: "verify:local", script, env });
    assert.ok(
      result.calls.some(([command]) => command === "start"),
      scenario,
    );
    assert.equal(existsSync(join(repo, ".artifacts/verified")), false, scenario);
  }
});

test("the test image ships Google Chrome Stable 144 or later", { timeout: 900_000 }, async () => {
  const version = await chromeVersion();
  const match = /^Google Chrome (\d+)\.\d+\.\d+\.\d+$/.exec(version);
  assert.ok(match, `Unexpected google-chrome --version output: ${version}`);
  assert.ok(Number(match[1]) >= 144, `Google Chrome ${match[1]} is older than 144`);
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
  assert.equal(directoryCopies(result.calls).length, 2);
  assert.equal(result.calls.at(-1)[0], "rm");
});

test(
  "stops interrupted tests, exports evidence and removes the container",
  { timeout: 10_000 },
  async (context) => {
    const result = await launch(context, "interrupt");
    assert.equal(result.code, 130, result.output);
    assert.ok(result.calls.some(([command]) => command === "stop"));
    assert.equal(directoryCopies(result.calls).length, 3);
    assert.equal(result.calls.at(-1)[0], "rm");
  },
);

test("public tests route through Docker while local variants and the hooks retain every gate", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const layer of ["unit", "components", "contract", "e2e", "browser", "coverage"]) {
    assert.equal(
      manifest.scripts[`test:${layer}`],
      `node scripts/test-container.mjs test:${layer}:local`,
    );
    assert.ok(manifest.scripts[`test:${layer}:local`]);
  }
  assert.equal(manifest.scripts["test:container"], "node --test tests/container/*.checks.mjs");
  assert.equal(manifest.scripts.ready, "vp run verify");
  assert.match(
    readFileSync(join(root, ".vite-hooks/pre-commit"), "utf8"),
    /vp staged\nvp check\nvp run --no-cache deps\nRECNRUN_TEST_QUIET=1 vp run --no-cache test:unit\n/,
  );
  // One hooksPath serves every worktree, so a branch without the marker hook falls back to the gate.
  assert.match(
    readFileSync(join(root, ".vite-hooks/pre-push"), "utf8"),
    /if \[ -f scripts\/git-hooks\/pre-push\.mjs \]; then node scripts\/git-hooks\/pre-push\.mjs; else vp run verify; fi/,
  );
});
