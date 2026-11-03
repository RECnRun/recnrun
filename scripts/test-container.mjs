import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanHead, recordVerified } from "./verified-commit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const [task, ...forwarded] = process.argv.slice(2);
const args = forwarded[0] === "--" ? forwarded.slice(1) : forwarded;
const tasks = new Set([
  "test:local",
  "verify:local",
  "test:unit:local",
  "test:components:local",
  "test:contract:local",
  "test:e2e:local",
  "test:browser:local",
  "test:coverage:local",
  "bench:local",
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
// Agents and hooks pay for streamed output in context; quiet runs keep it in run.log only.
const quietRun = process.env.RECNRUN_TEST_QUIET === "1";
const TAIL_LINES = 20;
const TAIL_BYTES = 64 * 1024;
let streamedTail = "";

function message(value) {
  console.error(value);
  log?.write(`${value}\n`);
}

// Quiet runs keep the end of the build and test output, never the helper calls', for the summary.
function relay(data, stream, quiet) {
  log?.write(data);
  if (quiet) return;
  if (quietRun) streamedTail = `${streamedTail}${data}`.slice(-TAIL_BYTES);
  else stream.write(data);
}

function docker(options, { quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn("docker", options, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      relay(data, process.stdout, quiet);
    });
    child.stderr.on("data", (data) => relay(data, process.stderr, quiet));
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
  // The capture benchmark names the image in its report.
  environment.push("--env", `RECNRUN_IMAGE_ID=${image}`);
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

async function collectArtifacts() {
  let code = 0;
  for (const directory of ["coverage", "test-results", "playwright-report"]) {
    try {
      const destination = join(artifacts, directory);
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

async function executeTests() {
  const available = await requireDocker();
  if (available !== 0 || interrupted) return available || interrupted;
  const built = await buildImage();
  if (built.code !== 0 || interrupted) return built.code || interrupted;
  image = built.stdout;
  return startTests();
}

// The pre-push hook skips verify for a commit whose full, unmodified verify passed on a clean tree.
async function recordPass(before) {
  if (process.exitCode !== 0 || task !== "verify:local" || args.length) return;
  const marker = await recordVerified(root, before, runId);
  if (marker) message(`Verify passed on clean commit ${before}: ${marker}`);
}

// Vitest and Playwright print their summaries last, so the output's tail carries the result.
function printSummary() {
  if (!quietRun) return;
  const tail = streamedTail.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  console.log(`Artifacts: ${artifacts}\nExit code: ${process.exitCode}\n${tail}`);
}

async function run() {
  if (!tasks.has(task)) throw new Error(`Unknown container test task: ${task}`);
  const before = task === "verify:local" ? cleanHead(root) : undefined;
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
    await recordPass(before);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await new Promise((done) => log.end(done));
    printSummary();
  }
}

await run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
