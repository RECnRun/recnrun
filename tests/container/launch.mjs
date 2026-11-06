import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/test-container.mjs");
const fixture = fileURLToPath(new URL("./docker-fixture.mjs", import.meta.url));

/** Runs scripts/test-container.mjs (or `script`) against the Docker fixture in a fresh directory. */
export function launch(context, scenario = "success", extra = [], options = {}) {
  const {
    task = "test:e2e:local",
    script = runner,
    env = {},
  } = typeof options === "string" ? { task: options } : options;
  const directory = mkdtempSync(join(tmpdir(), "recnrun-container-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  if (scenario !== "missing-cli") {
    writeFileSync(docker, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`);
    chmodSync(docker, 0o755);
  }
  // verify sets the smoke mode in the container; the checks decide it per task themselves.
  const { RECNRUN_EXPERIMENT_SAMPLES: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, [script, task, ...extra], {
    cwd: directory,
    env: {
      ...inherited,
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
