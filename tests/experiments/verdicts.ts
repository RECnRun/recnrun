import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One hypothesis outcome (PLAN.md decision 6). */
export interface Verdict {
  experiment: string;
  hypothesis: string;
  verdict: "pass" | "fail" | "unavailable";
  error?: string;
  /** `--version` of the browser that ran it, for example `Google Chrome 156.0.8078.79`. */
  chrome: string;
  samples: number;
  label?: "diagnostic" | "control";
  /** How the extension was loaded (E0's methods), for experiments that run inside it. */
  method?: string;
  /** Sub-cases of the hypothesis, when it was tried more than one way. */
  variants?: { name: string; verdict: Verdict["verdict"]; error?: string; samples?: number }[];
  /** Named sample counts behind the verdict, for example `firstEffectBeforeMarker` (E2). */
  counts?: Record<string, number>;
  /** Percentiles, in milliseconds, of named durations over the samples. */
  timings?: Record<string, { p50: number; p95: number; max: number }>;
  /** `RECNRUN_STRESS_CONDITION` of the run (scripts/test-stress.mjs), or `baseline`. */
  condition?: string;
  /** Samples where the worker ran before the bootstrap reached it; scripts/test-stress.mjs sums them. */
  lateAttaches?: number;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** `RECNRUN_RUN_ID` (set once per Playwright run by the browser config) or a timestamp. */
function evidenceDirectory(): string {
  const run = process.env.RECNRUN_RUN_ID ?? new Date().toISOString().replaceAll(":", "-");
  return join(ROOT, ".artifacts/evidence", run);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readVerdicts(): Promise<Verdict[]> {
  return readJson<Verdict[]>(join(evidenceDirectory(), "verdicts.json"), []);
}

export async function appendVerdict(verdict: Verdict): Promise<void> {
  const verdicts = await readVerdicts();
  await writeJson(join(evidenceDirectory(), "verdicts.json"), [...verdicts, verdict]);
}

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(target: Json, source: Json): Json {
  const merged: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/** Merges into `capabilities.json`; later experiments add keys without dropping earlier ones. */
export async function mergeCapabilities(capabilities: Json): Promise<Json> {
  const file = join(evidenceDirectory(), "capabilities.json");
  const merged = deepMerge(await readJson<Json>(file, {}), capabilities);
  await writeJson(file, merged);
  return merged;
}
