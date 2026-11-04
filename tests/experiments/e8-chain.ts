import { labelOf } from "./fixtures/e4-run.ts";
import type { Labels } from "./fixtures/e4-run.ts";

/*
 * E8's reading of the launcher's Downloads-root chain (scripts/poc-cross-profile/discovery.sh): its
 * output and exit code become labelled observations, and a cell's expectation is judged against them.
 */

/** What one run of discovery.sh left: its exit code and both streams. */
export interface ChainRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the chain printed, its exit code, and the candidates its stderr says it tried. */
export interface ChainSeen {
  code: number;
  found: string | null;
  tried: string[];
}

/** Each non-empty line of `text` as a folder label. */
export const labelled = (text: string, labels: Labels): string[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => labelOf(labels, line) ?? line);

/** The candidates of the chain's "not found: tried a, b" line; none when it says "no candidate". */
export function triedOf(stderr: string, labels: Labels): string[] {
  const line = /^discovery\.sh: not found: tried (.*)$/m.exec(stderr)?.[1];
  if (line === undefined || line === "no candidate") return [];
  return line.split(/, (?=\/)/).map((path) => labelOf(labels, path) ?? path);
}

export function chainSeen(run: ChainRun, labels: Labels): ChainSeen {
  return {
    code: run.code,
    found: labelled(run.stdout, labels)[0] ?? null,
    tried: triedOf(run.stderr, labels),
  };
}

/** What each step of the chain gave, run on its own. */
interface Steps {
  preferences: string | null;
  record: string[];
  find: string[];
}

export interface ChainObserved {
  chain: ChainSeen;
  candidates: string[];
  steps: Steps;
}

/** The root a cell must end on (null with exit 66), the candidates in order, and the steps' output. */
export interface ChainExpected {
  found: string | null;
  candidates: string[];
  steps: Steps;
}

const differs = (what: string, got: unknown, want: unknown): string[] =>
  JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`${what} was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];

/** Problems of one run: exit 0 on the expected root, or 66 listing every candidate, and the steps. */
export function chainProblems(seen: ChainObserved, expected: ChainExpected): string[] {
  const missing = expected.found === null;
  return [
    ...differs("exit code", seen.chain.code, missing ? 66 : 0),
    ...differs("printed root", seen.chain.found, expected.found),
    ...differs("tried candidates", seen.chain.tried, missing ? expected.candidates : []),
    ...differs("candidates", seen.candidates, expected.candidates),
    ...differs("preferences step", seen.steps.preferences, expected.steps.preferences),
    ...differs("record step", seen.steps.record, expected.steps.record),
    ...differs("find step", seen.steps.find, expected.steps.find),
  ];
}
