import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const playwrightCli = join(root, "node_modules/.bin/playwright");
const evidenceRoot = join(root, ".artifacts/evidence");
const TAG = "@order-critical";
const CONDITIONS = [
  "baseline",
  "net-delay",
  "cpu-load",
  "cold",
  "warm",
  "switch-early",
  "switch-late",
];
const DEFAULT_CONFIGS = ["playwright.experiments.config.ts", "playwright.browser.config.ts"];
const SHOWN_FAILURES = 10;
let interrupted = 0;
let activeChild;

function parseArguments(argv) {
  let iterations = process.env.RECNRUN_STRESS_ITERATIONS || "100";
  const configs = [];
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--iterations") iterations = argv[++index];
    else if (argument === "--config") configs.push(argv[++index]);
    else if (argument !== "--") forwarded.push(argument);
  }
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--iterations must be a positive integer, got ${iterations}.`);
  }
  return { iterations: count, configs: configs.length ? configs : DEFAULT_CONFIGS, forwarded };
}

function playwright(args, { env = process.env, capture = false } = {}) {
  return new Promise((done) => {
    const output = capture ? "pipe" : "inherit";
    const child = spawn(playwrightCli, ["test", ...args], {
      cwd: root,
      env,
      stdio: ["ignore", output, "inherit"],
    });
    activeChild = child;
    let stdout = "";
    child.stdout?.on("data", (data) => (stdout += data));
    child.on("error", (error) => console.error(error.message));
    child.on("close", (code) => {
      activeChild = undefined;
      done({ code: code ?? 1, stdout });
    });
  });
}

function collectSpecs(suites, path = []) {
  return suites.flatMap((suite) => {
    const titles = suite.title && suite.title !== suite.file ? [...path, suite.title] : path;
    const specs = (suite.specs ?? []).map((spec) => [spec.file, ...titles, spec.title].join(" › "));
    return [...specs, ...collectSpecs(suite.suites ?? [], titles)];
  });
}

async function listSpecs(config, forwarded) {
  const args = ["--config", config, "--grep", TAG, ...forwarded];
  const listing = ["--list", "--reporter=json", "--pass-with-no-tests"];
  const result = await playwright([...args, ...listing], { capture: true });
  if (result.code !== 0)
    throw new Error(`Playwright could not list ${config} (exit ${result.code}).`);
  return collectSpecs(JSON.parse(result.stdout).suites ?? []);
}

// Busy threads compete with Chrome for the CPU while the cpu-load iteration runs.
function startLoad(condition) {
  if (condition !== "cpu-load") return [];
  return Array.from(
    { length: availableParallelism() },
    () => new Worker("for (;;) {}", { eval: true }),
  );
}

async function readVerdicts(directory) {
  try {
    const verdicts = JSON.parse(await readFile(join(directory, "verdicts.json"), "utf8"));
    return Array.isArray(verdicts) ? { verdicts } : { verdicts: [], error: "not an array" };
  } catch (error) {
    // Tagged tests that recorded nothing are not a pass; the gate needs evidence from every iteration.
    if (error.code === "ENOENT")
      return { verdicts: [], error: "the tagged tests recorded nothing" };
    return { verdicts: [], error: error.message };
  }
}

async function runIteration(plan, index) {
  const condition = CONDITIONS[(index - 1) % CONDITIONS.length];
  const label = `${String(index).padStart(String(plan.iterations).length, "0")}-${condition}`;
  const runId = `${plan.run}/stress/${label}`;
  const directory = join(evidenceRoot, runId);
  const load = startLoad(condition);
  const busy = load.length ? ` (${load.length} busy threads)` : "";
  console.log(`\n[stress ${index}/${plan.iterations}] ${condition}${busy}`);
  const env = { ...process.env, RECNRUN_RUN_ID: runId, RECNRUN_STRESS_CONDITION: condition };
  env.RECNRUN_STRESS_ITERATION = String(index);
  if (load.length) env.RECNRUN_STRESS_CPU_THREADS = String(load.length);
  const failures = [];
  try {
    for (const [position, config] of plan.configs.entries()) {
      const output = join(directory, "test-results", `${position}-${basename(config)}`);
      const options = ["--workers=1", "--retries=0", "--reporter=line", "--output", output];
      const args = ["--config", config, "--grep", TAG, ...plan.forwarded, ...options];
      const result = await playwright(args, { env });
      if (result.code !== 0) failures.push(`${basename(config)} exited ${result.code}`);
    }
  } finally {
    await Promise.all(load.map((worker) => worker.terminate()));
  }
  const { verdicts, error } = await readVerdicts(directory);
  if (error) failures.push(`no verdicts.json: ${error}`);
  return { index, condition, runId, failures, verdicts };
}

// A leak count sits at the top level (E3, E6) or under counts (E8); either name means a late attach.
function lateCount(verdict) {
  const counts = verdict.counts ?? {};
  const value =
    verdict.lateAttaches ??
    verdict.firstEffectBeforeMarker ??
    counts.lateAttaches ??
    counts.firstEffectBeforeMarker;
  return Number.isFinite(value) ? value : 0;
}

function tally(perHypothesis, verdict, failures) {
  const key = `${verdict.experiment}/${verdict.hypothesis}`;
  perHypothesis[key] ??= { pass: 0, fail: 0, unavailable: 0, lateAttaches: 0 };
  const entry = perHypothesis[key];
  if (["pass", "fail", "unavailable"].includes(verdict.verdict)) entry[verdict.verdict] += 1;
  else failures.push(`${key}: unknown verdict ${JSON.stringify(verdict.verdict)}`);
  const late = lateCount(verdict);
  entry.lateAttaches += late;
  if (verdict.verdict === "fail") failures.push(`${key}: fail`);
  else if (verdict.verdict === "pass" && late > 0) {
    failures.push(`${key}: pass with ${late} late attach${late === 1 ? "" : "es"}`);
  }
}

function aggregate(plan, results) {
  const conditions = {};
  const perHypothesis = {};
  const failedIterations = [];
  for (const result of results) {
    conditions[result.condition] = (conditions[result.condition] ?? 0) + 1;
    const failures = [...result.failures];
    for (const verdict of result.verdicts) tally(perHypothesis, verdict, failures);
    if (failures.length) {
      const { index: iteration, condition, runId } = result;
      failedIterations.push({ iteration, condition, runId, failures });
    }
  }
  const { iterations: requested, specs } = plan;
  const iterations = results.length;
  return { iterations, requested, conditions, specs, perHypothesis, failedIterations };
}

function printSummary(summary, file) {
  const conditions = Object.entries(summary.conditions).map(([name, count]) => `${name} ${count}`);
  console.log(`\nStress: ${summary.iterations} of ${summary.requested} iterations`);
  console.log(`Conditions: ${conditions.join(", ")}`);
  console.log(
    `Specs (${summary.specs.length}):\n${summary.specs.map((spec) => `  ${spec}`).join("\n")}`,
  );
  console.log("Hypotheses:");
  const width = Math.max(10, ...Object.keys(summary.perHypothesis).map((key) => key.length));
  for (const [key, entry] of Object.entries(summary.perHypothesis)) {
    const counts = `pass ${entry.pass} fail ${entry.fail} unavailable ${entry.unavailable}`;
    console.log(`  ${key.padEnd(width)}  ${counts} lateAttaches ${entry.lateAttaches}`);
  }
  const failed = summary.failedIterations;
  console.log(`Failed iterations: ${failed.length}`);
  for (const entry of failed.slice(0, SHOWN_FAILURES)) {
    console.log(`  ${entry.runId}: ${entry.failures.join("; ")}`);
  }
  if (failed.length > SHOWN_FAILURES) console.log(`  and ${failed.length - SHOWN_FAILURES} more`);
  console.log(`Evidence: ${relative(root, file)}`);
}

async function plan(options) {
  const run = process.env.RECNRUN_RUN_ID || new Date().toISOString().replaceAll(":", "-");
  console.log(`Stress run ${run}: ${options.iterations} iterations of the ${TAG} specs`);
  const configs = [];
  const specs = [];
  for (const config of options.configs) {
    const listed = await listSpecs(config, options.forwarded);
    if (listed.length) configs.push(config);
    specs.push(...listed);
  }
  if (!specs.length) {
    const names = options.configs.join(" and ");
    throw new Error(`No Playwright test is tagged ${TAG} in ${names}; nothing to stress.`);
  }
  return { ...options, run, configs, specs };
}

function interrupt(signal) {
  interrupted ||= signal === "SIGINT" ? 130 : 143;
  console.error(`Received ${signal}; stopping after the current iteration.`);
  activeChild?.kill(signal);
}

async function main() {
  const stress = await plan(parseArguments(process.argv.slice(2)));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const results = [];
  for (let index = 1; index <= stress.iterations && !interrupted; index += 1) {
    results.push(await runIteration(stress, index));
  }
  const summary = aggregate(stress, results);
  const file = join(evidenceRoot, stress.run, "stress.json");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);
  printSummary(summary, file);
  const passed = summary.iterations === stress.iterations && !summary.failedIterations.length;
  console.log(passed ? "Stress passed: no hypothesis recorded a fail." : "Stress failed.");
  process.exitCode = interrupted || (passed ? 0 : 1);
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
