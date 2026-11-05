import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPathIn } from "./host-paths.ts";
import { sampleMode } from "./samples.ts";
import { parseVerdicts } from "./schema.ts";
import type { Verdict } from "./schema.ts";

export type { Verdict };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** `.artifacts/evidence/<RECNRUN_RUN_ID>`; the Playwright config sets the id once per run. */
function evidenceDirectory(): string {
  const run = process.env.RECNRUN_RUN_ID ?? new Date().toISOString().replaceAll(":", "-");
  return join(ROOT, ".artifacts/evidence", run);
}

/** `directory` defaults to the run's lab folder; host runs pass `.artifacts/evidence/host/<run>`. */
export async function readVerdicts(directory = evidenceDirectory()): Promise<Verdict[]> {
  try {
    return parseVerdicts(JSON.parse(await readFile(join(directory, "verdicts.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendVerdict(
  verdict: Verdict,
  directory = evidenceDirectory(),
): Promise<void> {
  const verdicts = await readVerdicts(directory);
  const stamped = sampleMode() === "smoke" ? { ...verdict, mode: "smoke" as const } : verdict;
  parseVerdicts([stamped]);
  const leaked = stamped.environment === "host" ? hostPathIn(JSON.stringify(stamped)) : undefined;
  if (leaked !== undefined) throw new Error(`A host verdict carries the host path ${leaked}`);
  await mkdir(directory, { recursive: true });
  const file = join(directory, "verdicts.json");
  await writeFile(file, `${JSON.stringify([...verdicts, stamped], null, 2)}\n`);
}
