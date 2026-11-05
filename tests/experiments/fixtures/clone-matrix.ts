import { laterCell, permissionsCell, reopenCell, threeRootsCell } from "./clone-cells.ts";
import { commandsCell } from "./clone-commands.ts";
import { openRound } from "./clone-round.ts";
import type { Round } from "./clone-round.ts";
import { isolationCell } from "./clone-storage.ts";
import { CLONE_CELLS, recordClone } from "./clones.ts";
import type { CloneHost, CloneHypothesis, RoundSamples } from "./clones.ts";
import type { VerdictTarget } from "./downloads-verdicts.ts";
import type { Sample } from "../outcome.ts";

/*
 * The matrix of P5.5 as rounds: each round makes A and B, runs the cells in the order the clones
 * live them (CL08 closes A and CL11 closes B before C exists), and gives every cell's sample the
 * round's measurements. The first cell to record runs the rounds; the others take what they left.
 */

/** A cell that threw is a fail with its message, since the round it ran in did start. */
async function guarded(cell: (round: Round) => Promise<Sample>, round: Round): Promise<Sample> {
  try {
    return await cell(round);
  } catch (error) {
    return { ok: false, error: (error as Error).message, observation: {} };
  }
}

const median = (values: number[]) =>
  [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];

/** The copy, space, ready, and link figures of the clones of a round. */
function measurementsOf(round: Round) {
  return round.clones.map(({ name, created, readyMs, linkMs }) => ({
    name,
    copyS: created.copyS,
    copyWallMs: created.wallMs,
    physicalKiB: created.physicalKiB,
    logicalBytes: created.logicalBytes,
    readyMs,
    linkMs,
  }));
}

/** A round that could not be made leaves every cell a fail that says why. */
const unmade = (error: unknown): RoundSamples =>
  Object.fromEntries(
    Object.keys(CLONE_CELLS).map((cell) => [
      cell,
      { ok: false, error: `the round did not start: ${(error as Error).message}`, observation: {} },
    ]),
  ) as unknown as RoundSamples;

/** One round: the six samples. */
async function runRound(host: CloneHost): Promise<RoundSamples> {
  const round = await openRound(host).catch((error: unknown) => error as Error);
  if (round instanceof Error) return unmade(round);
  try {
    const samples = {
      "P5.5.CL05.threeRoots": await guarded(threeRootsCell, round),
      "P5.5.CL09.permissions": await guarded(permissionsCell, round),
      "P5.5.CL10.commands": await guarded(commandsCell, round),
      "P5.5.CL08.isolation": await guarded(isolationCell, round),
      "P5.5.CL11.reopenB": await guarded(reopenCell, round),
      "P5.5.CL12.cLater": await guarded(laterCell, round),
    } satisfies RoundSamples;
    const measurements = measurementsOf(round);
    const withFigures = (sample: Sample): Sample => ({
      ...sample,
      observation: { ...sample.observation, measurements },
    });
    return Object.fromEntries(
      Object.entries(samples).map(([cell, sample]) => [cell, withFigures(sample)]),
    ) as RoundSamples;
  } finally {
    for (const clone of round.clones) await host.stop(clone.profile).catch(() => undefined);
  }
}

/** Hands each cell its sample of the next round, running the round when the first cell asks. */
export function matrix(host: CloneHost, target: VerdictTarget) {
  const rounds: RoundSamples[] = [];
  const taken = new Map<CloneHypothesis, number>();
  const sample = async (cell: CloneHypothesis): Promise<Sample> => {
    const index = taken.get(cell) ?? 0;
    taken.set(cell, index + 1);
    if (index >= rounds.length) rounds.push(await runRound(host));
    const found = rounds[index]?.[cell];
    if (!found) throw new Error(`No round left a sample for ${cell}.`);
    return found;
  };
  return {
    record: (cell: CloneHypothesis) => recordClone(cell, target, () => sample(cell)),
    rounds: () => rounds,
    median,
  };
}
