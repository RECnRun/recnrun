import { waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import {
  longestGap,
  presenceRewrites,
  presenceStamp,
  recordOf,
  signalLands,
  signalNow,
  signalWrites,
  within,
  workerListed,
  writesOf,
} from "./fixtures/e5-observe.ts";
import { arrive, identityOf, linkedWith, pairOf, quiet, withGroup } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import { PRESENCE_TTL_MS, signalFile } from "./fixtures/e5-virtual.ts";

/*
 * E5's cells where a profile quits, crashes, restarts, or runs with no extension page and no
 * client attached (POC PLAN.md P3.2 and §7.4), on the Default plus one worker. Chrome is stopped
 * only through the PID this run spawned.
 */

const OFFER_MS = 30_000;
const LINK_MS = 30_000;
/** A restarted pair links again within two retry periods (RETRY_MS, 30 s, of folder-pairing.ts). */
const RELINK_MS = 60_000;
/** Past the worker's 30 s idle delay (CHROMIUM.md group 12). */
const IDLE_MS = 35_000;
/** Two presence lifetimes and a margin, with every extension page closed. */
const UNATTENDED_MS = 2 * PRESENCE_TTL_MS + 5_000;

/** The pair, linked, with what each side wrote so far. */
async function linkedPair(group: DownloadsGroup) {
  const { profiles } = await arrive(group, 2);
  const pair = pairOf(profiles);
  const linkMs = await waitForMesh(profiles, LINK_MS);
  return { profiles, ...pair, linkMs };
}

/** The profile's presence once it carries a boot other than `boot`. */
const nextPresence = (group: DownloadsGroup, profile: DownloadsProfile, boot: string | undefined) =>
  within(async () => {
    const stamp = await presenceStamp(group.downloads, profile.profileId);
    return stamp && stamp.boot !== boot ? stamp : undefined;
  }, 15_000);

const relinked = async (profiles: DownloadsProfile[], ms = RELINK_MS) =>
  waitForMesh(profiles, ms).catch(() => undefined);

/** E5.a.quitDuringIce: the answerer dies once it has read the offer, comes back, and the pair links. */
export const quitDuringIceSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await arrive(group, 2);
    const { offerer, answerer } = pairOf(profiles);
    const before = await identityOf(answerer);
    const offerPath = signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId);
    const offer = await signalLands(offerPath, OFFER_MS);
    if (!offer) return judged([`no offer within ${OFFER_MS} ms`], {});
    // accept() trusts the offerer before it gathers ICE: the kill lands while it gathers or just after.
    const reading = await within(
      async () => (await recordOf(answerer, "local", "authorizedPeers", offerer)) ?? undefined,
      OFFER_MS,
      5,
    );
    await group.kill(answerer);
    const killedAt = Date.now();
    const answer = await signalNow(group.downloads, answerer, "answer", offerer);
    const answerOutBeforeKill = answer?.pairingId === offer.signal.pairingId;
    await group.relaunch(answerer);
    const linkMs = await relinked(profiles);
    const after = await identityOf(answerer);
    const observation = {
      readBeforeKill: reading !== undefined,
      answerOutBeforeKill,
      relinkAfterKillMs: linkMs === undefined ? undefined : Date.now() - killedAt,
      sameProfileId: after.profileId === before.profileId,
    };
    const problems = [
      ...(reading ? [] : ["the answerer never read the offer"]),
      ...(linkMs === undefined ? [`no link within ${RELINK_MS} ms of the relaunch`] : []),
      ...(observation.sameProfileId ? [] : ["the relaunched answerer has another profile id"]),
    ];
    return judged(problems, observation);
  });

/** How often E5.a.quitAfterAnswer looks for the answer: the offerer reads it 100 ms or more after it lands. */
const ANSWER_POLL_MS = 5;

/**
 * E5.a.quitAfterAnswer: the answerer dies once its answer is on disk and before the link is up,
 * comes back, and the pair links within two retry periods; it never answers that offer again.
 */
export const quitAfterAnswerSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await arrive(group, 2);
    const { offerer, answerer } = pairOf(profiles);
    const before = await identityOf(answerer);
    const offerPath = signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId);
    const offer = await signalLands(offerPath, OFFER_MS);
    if (!offer) return judged([`no offer within ${OFFER_MS} ms`], {});
    const { pairingId } = offer.signal;
    const answerPath = signalFile(group.downloads, answerer.profileId, "answer", offerer.profileId);
    const mine = (each: { pairingId?: string }) => each.pairingId === pairingId;
    const answer = await signalLands(answerPath, OFFER_MS, mine, ANSWER_POLL_MS);
    await group.kill(answerer);
    const killedAt = Date.now();
    // A link verified now came up before the kill, since its DTLS needs the answerer alive.
    const linkedBeforeKill = await linkedWith(offerer, answerer);
    await group.relaunch(answerer);
    const linkMs = await relinked(profiles);
    const after = await identityOf(answerer);
    const answers = (await signalWrites(answerer)).filter(
      (each) => each.name.startsWith("answer-") && mine(each),
    ).length;
    const observation = {
      killAfterAnswerMs: answer ? Math.round(killedAt - answer.mtimeMs) : undefined,
      linkedBeforeKill,
      relinkAfterKillMs: linkMs === undefined ? undefined : Date.now() - killedAt,
      answersToThatOffer: answers,
      sameProfileId: after.profileId === before.profileId,
    };
    const problems = [
      ...(answer ? [] : [`no answer within ${OFFER_MS} ms`]),
      ...(linkedBeforeKill ? ["the link came up before the kill"] : []),
      ...(linkMs === undefined ? [`no link within ${RELINK_MS} ms of the relaunch`] : []),
      ...(answers === 1 ? [] : [`that offer was answered ${answers} times`]),
      ...(observation.sameProfileId ? [] : ["the relaunched answerer has another profile id"]),
    ];
    return judged(problems, observation);
  });

/** E5.a.bothRestart: both quit, both come back on their roots, and they link with the same identities. */
export const bothRestartSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await linkedPair(group);
    const before = await Promise.all(profiles.map(identityOf));
    const boots = await Promise.all(
      profiles.map((each) => presenceStamp(group.downloads, each.profileId)),
    );
    for (const profile of profiles) await group.quit(profile);
    const quitAt = Date.now();
    for (const profile of profiles) await group.relaunch(profile);
    const fresh = await Promise.all(
      profiles.map((each, index) => nextPresence(group, each, boots[index]?.boot)),
    );
    const linkMs = await relinked(profiles);
    const after = await Promise.all(profiles.map(identityOf));
    const observation = {
      relinkAfterQuitMs: linkMs === undefined ? undefined : Date.now() - quitAt,
      newBoots: fresh.every((each) => each !== undefined),
      sameProfileIds: after.every((each, index) => each.profileId === before[index]?.profileId),
      samePins: after.every((each, index) => each.pins === before[index]?.pins),
    };
    const problems = [
      ...(linkMs === undefined ? [`no link within ${RELINK_MS} ms of the relaunch`] : []),
      ...(observation.newBoots ? [] : ["a relaunched profile kept its earlier boot"]),
      ...(observation.sameProfileIds ? [] : ["a relaunched profile has another profile id"]),
      ...(observation.samePins ? [] : ["a relaunched profile changed its pins"]),
    ];
    return judged(problems, observation);
  });

const listedNow = async (profiles: DownloadsProfile[]) =>
  Object.fromEntries(
    await Promise.all(profiles.map(async (each) => [each.name, await workerListed(each)])),
  );

/**
 * E5.a.noPage: with no extension page and no client on either profile, the answerer crashes and
 * comes back unattended; the pair exchanges files and links again, seen from disk, then attached.
 */
export const noPageSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles, offerer, answerer } = await linkedPair(group);
    for (const profile of profiles) await group.detach(profile);
    await quiet(IDLE_MS);
    const workersAfterIdle = await listedNow(profiles);
    const earlier = (await signalNow(group.downloads, offerer, "offer", answerer))?.pairingId;
    await group.kill(answerer);
    const killedAt = Date.now();
    await group.relaunch(answerer, { attach: false });
    const offerPath = signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId);
    const offer = await signalLands(offerPath, RELINK_MS, (each) => each.pairingId !== earlier);
    const answerPath = signalFile(group.downloads, answerer.profileId, "answer", offerer.profileId);
    const answer =
      offer &&
      (await signalLands(answerPath, LINK_MS, (each) => each.pairingId === offer.signal.pairingId));
    const exchangedMs = answer ? Math.round(answer.mtimeMs - killedAt) : undefined;
    const workersUnattended = await listedNow(profiles);
    for (const profile of profiles) await group.attach(profile);
    const linkMs = await relinked(profiles, LINK_MS);
    // Its record of the offers it answered outlives the browser, so the last one on disk gets no second answer.
    const earlierAnswers = (await signalWrites(answerer)).filter(
      (each) => each.name.startsWith("answer-") && each.pairingId === earlier,
    ).length;
    const problems = [
      ...(offer ? [] : ["the unattended offerer wrote no new offer"]),
      ...(answer ? [] : ["the unattended answerer did not answer it"]),
      ...(linkMs === undefined ? ["the pair was not linked once attached"] : []),
      ...(earlierAnswers <= 1 ? [] : [`the earlier offer was answered ${earlierAnswers} times`]),
    ];
    return judged(problems, {
      workersAfterIdle,
      workersUnattended,
      exchangedAfterKillMs: exchangedMs,
      earlierOfferAnswers: earlierAnswers,
    });
  });

/**
 * E5.a.closePages: every extension page closed and no client attached for two presence lifetimes;
 * each presence keeps being rewritten, and the link stays up without a new offer.
 */
export const closePagesSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles, offerer, answerer } = await linkedPair(group);
    const offers = () => writesOf(offerer, `offer-${answerer.profileId}.json`);
    const offersBefore = await offers();
    for (const profile of profiles) await group.detach(profile);
    const stamps = await Promise.all(
      profiles.map((each) => presenceRewrites(group.downloads, each.profileId, UNATTENDED_MS)),
    );
    const until = Date.now();
    const workers = await listedNow(profiles);
    for (const profile of profiles) await group.attach(profile);
    const gaps = stamps.map((each) => longestGap(each, until));
    const stillLinked =
      (await linkedWith(offerer, answerer)) && (await linkedWith(answerer, offerer));
    const newOffers = (await offers()) - offersBefore;
    const problems = [
      ...gaps.flatMap((gap, index) =>
        gap > PRESENCE_TTL_MS
          ? [`${profiles[index]?.name} left its presence ${gap} ms unrefreshed`]
          : [],
      ),
      ...(stillLinked ? [] : ["the link was down once attached"]),
      ...(newOffers === 0 ? [] : [`the offerer wrote ${newOffers} new offers`]),
    ];
    return judged(problems, {
      rewrites: stamps.map((each) => each.length),
      longestGapsMs: gaps,
      workers,
      newOffers,
    });
  });
