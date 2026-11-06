import { waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import type { Sample, VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import { recordOf, signalLands, within, writesOf } from "./fixtures/e5-observe.ts";
import { arrive, pairOf, withGroup } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import { decodeCode, signalFile } from "./fixtures/e5-virtual.ts";
import { recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";

/*
 * The samples of E5 (POC PLAN.md P3.2), shared by the lab spec and its host twin: one per cell
 * E5.<topology>.<hypothesis>, each on profiles and a Downloads folder of its own. E5.a is the
 * Default plus one worker, E5.b the Default plus four.
 */

// POLL_MS of apps/extension/src/offscreen/folder-watch.ts.
const POLL_MS = 1_000;
/** One file:// read of the catalog and the peer's three files, and the background's decision. */
const READ_SLACK_MS = 500;
const OFFER_MS = 30_000;
const LINK_MS = 30_000;

const TWO = "Default plus one worker, one shared Downloads root";
const TWO_VIRTUAL =
  "Default plus one worker and a virtual peer the test writes, one shared Downloads root";
const FIVE = "Default plus four workers, one shared Downloads root";

/** Each cell and its topology. */
export const E5_CELLS = {
  "E5.a.arrival": TWO,
  "E5.a.iceComplete": TWO,
  "E5.a.previousRun": TWO_VIRTUAL,
  "E5.a.simultaneous": TWO,
  "E5.a.duplicate": TWO_VIRTUAL,
  "E5.a.expired": TWO_VIRTUAL,
  "E5.a.corrupt": TWO_VIRTUAL,
  "E5.a.clockChange": TWO_VIRTUAL,
  "E5.a.quitDuringIce": TWO,
  "E5.a.quitAfterAnswer": TWO,
  "E5.a.bothRestart": TWO,
  "E5.a.readCache": TWO_VIRTUAL,
  "E5.a.noPage": TWO,
  "E5.a.closePages": TWO,
  "E5.b.mesh": FIVE,
  "E5.b.fifth": FIVE,
  "E5.b.killExecutor": FIVE,
  "E5.b.disconnectForget": FIVE,
} as const;
export type E5Hypothesis = keyof typeof E5_CELLS;

/** The cells §7.4 of the plan automates in the lab only. */
const LAB_ONLY: readonly E5Hypothesis[] = ["E5.a.expired", "E5.a.corrupt", "E5.b.disconnectForget"];
export const HOST_CELLS = (Object.keys(E5_CELLS) as E5Hypothesis[]).filter(
  (each) => !LAB_ONLY.includes(each),
);

async function e5Cell(hypothesis: E5Hypothesis, target: VerdictTarget): Promise<Cell> {
  return {
    experiment: "E5",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: E5_CELLS[hypothesis],
    debugger: "none",
  };
}

/** Records one E5 verdict through outcome.ts: `full` samples (one in smoke mode). */
export async function recordE5(
  hypothesis: E5Hypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
  full = 3,
) {
  const directory = target.directory?.();
  const options = directory === undefined ? { full } : { full, directory };
  return recordHypothesis(await e5Cell(hypothesis, target), take, options);
}

/** The offer file of the pair, and the answer file to it. */
const filesOf = (group: DownloadsGroup, offerer: DownloadsProfile, answerer: DownloadsProfile) => ({
  offer: signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId),
  answer: signalFile(group.downloads, answerer.profileId, "answer", offerer.profileId),
});

/** Polls `read` until it answers true. */
const becomes = (read: () => Promise<boolean>, ms: number) =>
  within(async () => ((await read()) ? true : undefined), ms);

/** The pair's first offer and its answer, each with when its reader acted on it. */
async function handshake(
  group: DownloadsGroup,
  offerer: DownloadsProfile,
  answerer: DownloadsProfile,
) {
  const files = filesOf(group, offerer, answerer);
  const offer = await signalLands(files.offer, OFFER_MS);
  if (!offer) return undefined;
  // accept() trusts the offerer before it gathers, so this marks when the offer was read.
  const read = await becomes(
    async () => (await recordOf(answerer, "local", "authorizedPeers", offerer)) !== undefined,
    LINK_MS,
  );
  const match = (each: { pairingId: string }) => each.pairingId === offer.signal.pairingId;
  const answer = await signalLands(files.answer, LINK_MS, match);
  const accepted =
    answer &&
    (await becomes(
      async () => (await recordOf(offerer, "session", "pendingOffers", answerer)) === undefined,
      LINK_MS,
    ));
  return { offer, read, answer, accepted };
}

const late = (ms: number | undefined, what: string) =>
  ms === undefined
    ? [`${what} was never acted on`]
    : ms > POLL_MS + READ_SLACK_MS
      ? [`${what} took ${ms} ms, more than the ${POLL_MS} ms poll and ${READ_SLACK_MS} ms to read`]
      : [];

/** E5.a.arrival: each file is acted on within one poll period of landing. */
export const arrivalSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { offerer, answerer } = pairOf((await arrive(group, 2)).profiles);
    const seen = await handshake(group, offerer, answerer);
    if (!seen) return judged([`no offer landed within ${OFFER_MS} ms of the first catalog`], {});
    const offerMs = seen.read ? Math.round(seen.read.at - seen.offer.mtimeMs) : undefined;
    const answerMs =
      seen.accepted && seen.answer ? Math.round(seen.accepted.at - seen.answer.mtimeMs) : undefined;
    const linkMs = await waitForMesh([offerer, answerer], LINK_MS).catch(() => undefined);
    const problems = [
      ...late(offerMs, "the offer"),
      ...late(answerMs, "the answer"),
      ...(linkMs === undefined ? [`no link within ${LINK_MS} ms`] : []),
    ];
    return judged(problems, {
      offerToAnswererMs: offerMs,
      answerToOffererMs: answerMs,
      linkMs,
      pollMs: POLL_MS,
    });
  });

const candidatesIn = (code: string) =>
  decodeCode(code)
    .sdp.split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:")).length;

/** E5.a.iceComplete: each side publishes one file, with its candidates gathered. */
export const iceCompleteSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { offerer, answerer } = pairOf((await arrive(group, 2)).profiles);
    const seen = await handshake(group, offerer, answerer);
    const linkMs = await waitForMesh([offerer, answerer], LINK_MS).catch(() => undefined);
    if (!seen?.answer)
      return judged(["the pair did not exchange an offer and an answer"], { linkMs });
    const observation = {
      offerCandidates: candidatesIn(seen.offer.signal.code),
      answerCandidates: candidatesIn(seen.answer.signal.code),
      offerWrites: await writesOf(offerer, `offer-${answerer.profileId}.json`),
      answerWrites: await writesOf(answerer, `answer-${offerer.profileId}.json`),
      linkMs,
    };
    const problems = [
      ...(observation.offerCandidates === 0 ? ["the offer carries no candidate"] : []),
      ...(observation.answerCandidates === 0 ? ["the answer carries no candidate"] : []),
      ...(observation.offerWrites === 1
        ? []
        : [`the offerer wrote ${observation.offerWrites} offers`]),
      ...(observation.answerWrites === 1
        ? []
        : [`the answerer wrote ${observation.answerWrites} answers`]),
      ...(linkMs === undefined ? [`no link within ${LINK_MS} ms`] : []),
    ];
    return judged(problems, observation);
  });

/** E5.a.simultaneous: both arrive in the first catalog, and only the lower id offers. */
export const simultaneousSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles, first } = await arrive(group, 2);
    const { offerer, answerer } = pairOf(profiles);
    const listed = profiles.filter((each) => first.registry?.peers[each.profileId]).length;
    const linkMs = await waitForMesh(profiles, LINK_MS).catch(() => undefined);
    const observation = {
      listedInFirstCatalog: listed,
      lowerOffers: await writesOf(offerer, `offer-${answerer.profileId}.json`),
      higherOffers: await writesOf(answerer, `offer-${offerer.profileId}.json`),
      higherAnswers: await writesOf(answerer, `answer-${offerer.profileId}.json`),
      linkMs,
    };
    const problems = [
      ...(listed === 2 ? [] : [`the first catalog listed ${listed} of the 2 profiles`]),
      ...(observation.lowerOffers === 1
        ? []
        : [`the lower id wrote ${observation.lowerOffers} offers`]),
      ...(observation.higherOffers === 0
        ? []
        : [`the higher id wrote ${observation.higherOffers} offers`]),
      ...(linkMs === undefined ? [`no link within ${LINK_MS} ms`] : []),
    ];
    return judged(problems, observation);
  });
