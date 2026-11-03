import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleMode } from "./samples.ts";
import type { SampleMode } from "./samples.ts";

/** One hypothesis outcome (POC PLAN.md decision 8). */
export interface Verdict {
  experiment: string;
  hypothesis: string;
  verdict: "pass" | "fail" | "unavailable";
  error?: string;
  /** `--version` of the browser that ran it, as versions.json records it: `Google Chrome 156.0.8078.79`. */
  chrome: string;
  environment: "lab";
  install: "loadUnpacked" | "managed-policy";
  /** `diagnostic` when a CDP client was connected, `strict` when none could exist. */
  label: "diagnostic" | "strict";
  /** The build of the extension: `test` until the POC modes of decision 6 exist. */
  variant: string;
  topology: string;
  /** Whether the build declares or uses `debugger`: `none` for the test build. */
  debugger: "none" | "declared" | "used";
  /** Whether any client outside Chrome (CDP) was connected while the hypothesis ran. */
  externalClient: boolean;
  samples: number;
  /** What each sample observed, for the report. */
  observations?: unknown[];
  /** `smoke` when `verify` ran the spec with one sample per hypothesis; absent means full evidence. */
  mode?: SampleMode;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** `.artifacts/evidence/<RECNRUN_RUN_ID>`; the Playwright config sets the id once per run. */
function evidenceDirectory(): string {
  const run = process.env.RECNRUN_RUN_ID ?? new Date().toISOString().replaceAll(":", "-");
  return join(ROOT, ".artifacts/evidence", run);
}

export async function readVerdicts(): Promise<Verdict[]> {
  try {
    return JSON.parse(
      await readFile(join(evidenceDirectory(), "verdicts.json"), "utf8"),
    ) as Verdict[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendVerdict(verdict: Verdict): Promise<void> {
  const verdicts = await readVerdicts();
  const stamped = sampleMode() === "smoke" ? { ...verdict, mode: "smoke" as const } : verdict;
  await mkdir(evidenceDirectory(), { recursive: true });
  const file = join(evidenceDirectory(), "verdicts.json");
  await writeFile(file, `${JSON.stringify([...verdicts, stamped], null, 2)}\n`);
}
