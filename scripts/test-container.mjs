import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const [task, ...forwarded] = process.argv.slice(2);
const args = forwarded[0] === "--" ? forwarded.slice(1) : forwarded;
const tasks = new Set([
  "test:local",
  "verify:local",
  "test:unit:local",
  "test:components:local",
  "test:e2e:local",
  "test:browser:local",
  "test:experiments:local",
  "test:coverage:local",
]);
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
const artifacts = resolve(
  process.env.RECNRUN_TEST_ARTIFACTS ?? join(root, ".artifacts/docker"),
  runId,
);
const container = `recnrun-tests-${randomUUID()}`;
let log;
let image;
let activeChild;
let created = false;
let interrupted = 0;
let stopping;

function message(value) {
  console.error(value);
  log?.write(`${value}\n`);
}

function docker(options, { quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn("docker", options, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      log?.write(data);
      if (!quiet) process.stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      log?.write(data);
      if (!quiet) process.stderr.write(data);
    });
    child.on("error", (error) => message(error.message));
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      done({ code: code !== null && code >= 0 ? code : 1, stdout: stdout.trim() });
    });
  });
}

function interrupt(signal) {
  if (interrupted) return;
  interrupted = signal === "SIGINT" ? 130 : 143;
  message(`Received ${signal}; stopping tests and collecting available artifacts.`);
  if (created) {
    stopping = docker(["stop", "--time", "10", container], { quiet: true });
  } else {
    activeChild?.kill("SIGTERM");
  }
}

async function requireDocker() {
  const result = await docker(["info", "--format", "{{.OSType}}"], { quiet: true });
  if (result.code !== 0) {
    message("Docker is not available. Start Docker Desktop and rerun the command.");
  }
  return result.code;
}

async function buildImage() {
  const imageFile = join(artifacts, "image-id");
  const result = await docker([
    "build",
    "--file",
    "Dockerfile.tests",
    "--iidfile",
    imageFile,
    root,
  ]);
  if (result.code !== 0) return result;
  return { code: 0, stdout: (await readFile(imageFile, "utf8")).trim() };
}

async function startTests() {
  const environment = ["CI", "DEBUG", "FORCE_COLOR"].flatMap((key) =>
    process.env[key] === undefined ? [] : ["--env", `${key}=${process.env[key]}`],
  );
  // Experiments name their evidence directory after the run (tests/experiments/verdicts.ts).
  environment.push("--env", `RECNRUN_RUN_ID=${runId}`);
  const result = await docker(
    [
      "create",
      "--init",
      "--shm-size=2g",
      "--name",
      container,
      "--label",
      "com.recnrun.tests=true",
      ...environment,
      image,
      task,
      ...args,
    ],
    { quiet: true },
  );
  if (result.code !== 0) return result.code;
  created = true;
  if (interrupted) return interrupted;
  const attached = await docker(["start", "--attach", container]);
  await stopping;
  const waited = await docker(["wait", container], { quiet: true });
  if (waited.code !== 0) return waited.code;
  const code = Number(waited.stdout);
  if (!/^\d+$/.test(waited.stdout) || code > 255) {
    message(`Docker returned an invalid test exit code: ${waited.stdout}`);
    return 1;
  }
  return code || attached.code;
}

async function collectArtifacts() {
  let code = 0;
  const directories = [
    ["coverage", "coverage"],
    ["test-results", "test-results"],
    ["playwright-report", "playwright-report"],
    [".artifacts/evidence", "evidence"],
  ];
  for (const [directory, exported] of directories) {
    try {
      const destination = join(artifacts, exported);
      await mkdir(destination, { recursive: true });
      const result = await docker(["cp", `${container}:/workspace/${directory}/.`, destination], {
        quiet: true,
      });
      if (result.code !== 0) throw new Error(`docker cp exited ${result.code}`);
    } catch (error) {
      message(`Could not export ${directory} artifacts: ${error.message}`);
      code = 1;
    }
  }
  const versions = await collectVersions();
  return code || versions;
}

async function collectVersions() {
  const destination = join(artifacts, "versions.json");
  try {
    const result = await docker(["cp", `${container}:/opt/recnrun/versions.json`, destination], {
      quiet: true,
    });
    if (result.code !== 0) throw new Error(`docker cp exited ${result.code}`);
    const versions = JSON.parse(await readFile(destination, "utf8"));
    await writeFile(destination, `${JSON.stringify({ ...versions, image }, null, 2)}\n`);
    return 0;
  } catch (error) {
    message(`Could not export the image's versions.json: ${error.message}`);
    return 1;
  }
}

async function executeTests() {
  const available = await requireDocker();
  if (available !== 0 || interrupted) return available || interrupted;
  const built = await buildImage();
  if (built.code !== 0 || interrupted) return built.code || interrupted;
  image = built.stdout;
  return startTests();
}

async function run() {
  if (!tasks.has(task)) throw new Error(`Unknown container test task: ${task}`);
  if (process.env.RECNRUN_TEST_CONTAINER === "1") {
    throw new Error("Use the :local test tasks inside the test container.");
  }
  await mkdir(artifacts, { recursive: true });
  log = createWriteStream(join(artifacts, "run.log"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let code = 1;
  try {
    message(`Running ${task} in Docker. Artifacts: ${artifacts}`);
    code = await executeTests();
  } finally {
    await stopping;
    if (created) {
      const exported = await collectArtifacts();
      const removed = await docker(["rm", "--force", container], { quiet: true });
      if (removed.code !== 0) message(`Could not remove test container ${container}.`);
      code ||= exported || removed.code;
    }
    process.exitCode = interrupted || code;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await new Promise((done) => log.end(done));
  }
}

await run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
