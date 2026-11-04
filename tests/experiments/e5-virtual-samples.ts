import { randomUUID } from "node:crypto";
import { waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup } from "../browser/fixtures/downloads-profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { pairingLog, recordOf, signalLands, within, writesOf } from "./fixtures/e5-observe.ts";
import {
  ANSWER_MS,
  answeredLate,
  answerTo,
  arrive,
  beside,
  catalogued,
  ignored,
  listedVirtual,
  offered,
  quiet,
  virtualIn,
  withGroup,
} from "./fixtures/e5-run.ts";
import type { E5Environment, Facing } from "./fixtures/e5-run.ts";
import {
  HIGHEST_ID,
  LOWEST_ID,
  PAIRING_TTL_MS,
  PRESENCE_TTL_MS,
  signalFile,
} from "./fixtures/e5-virtual.ts";

/*
 * E5's cells that need a file no real profile would write (POC PLAN.md P3.2): the virtual peer
 * of fixtures/e5-virtual.ts writes it into the throwaway Downloads folder beside the Default and
 * one worker, and the Default's answers, or their absence, are the measurement. A control the
 * Default must answer comes before and after each mutation, so silence means the file was refused.
 */

const HOUR_MS = 60 * 60_000;
/** An id between the virtual peers', for presences the catalog must refuse. */
const THIRD_ID = "00000000-0000-4000-8000-000000000001";
const OFFER_MS = 30_000;
const LINK_MS = 30_000;
/** Long enough for a poll that reads a new presence before the next file is written. */
const SETTLE_MS = 2_000;
/** A rewrite of one offer path must be answered within two polls and one ICE gathering. */
const REREAD_MS = 3_000;
/** A presence within the clock skew is heard at once: one poll, a read, and the answer's ICE. */
const PROMPT_MS = 2_000;

/** The Default facing a listed virtual peer `profileId`, the worker linking beside them. */
async function facing(group: DownloadsGroup, profileId = LOWEST_ID) {
  const { profiles } = await arrive(group, 2);
  const [to] = profiles;
  if (!to) throw new Error("No Default launched.");
  const log = pairingLog(to);
  const peer = await listedVirtual(group, to, profileId);
  const pairLinked = async () =>
    (await waitForMesh(profiles, LINK_MS).catch(() => undefined)) !== undefined;
  const run: Facing = { group, peer, to, answers: [], unanswerable: [] };
  return { facing: run, pairLinked, log };
}

/** A fresh offer of the facing peer, answered within ANSWER_MS: the control. */
const control = async (run: Facing) =>
  (await offered(run, await run.peer.signal("offer", run.to.profileId))) !== undefined;

/** The problems of a sample: each expectation that did not hold, by name. */
const failing = (checks: Record<string, boolean>) =>
  Object.entries(checks).flatMap(([name, held]) => (held ? [] : [`${name} did not hold`]));

/**
 * The sample: every check, what else it saw, each answer's delay, and the log when one failed.
 * An offer refused at first and answered later fails too, read from Chrome's own history.
 */
async function verdictOf(
  { facing: run, log }: { facing: Facing; log: () => string[] },
  checks: Record<string, boolean>,
  seen: Record<string, unknown> = {},
) {
  const late = await answeredLate(run);
  const problems = [...failing(checks), ...late.map((id) => `offer ${id} was answered late`)];
  const trail = problems.length > 0 ? { log: log() } : {};
  return judged(problems, { ...checks, ...seen, answerMs: run.answers, ...trail });
}

/** E5.a.previousRun: a signal of an earlier boot, or a lower sequence of this boot, is not answered. */
export const previousRunSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const { peer, to } = run;
    const earlier = await peer.announce();
    const checks: Record<string, boolean> = { firstAnswered: await control(run) };
    const oldBoot = peer.boot;
    peer.boot = randomUUID();
    await peer.announce();
    await quiet(SETTLE_MS);
    const stale = await peer.signal("offer", to.profileId, { boot: oldBoot });
    checks.earlierBootIgnored = await ignored(run, JSON.stringify(stale), stale.pairingId);
    // A late write of the earlier run's presence does not bring its boot back.
    await peer.writePresence(JSON.stringify(earlier));
    await quiet(SETTLE_MS);
    const late = await peer.signal("offer", to.profileId, { boot: oldBoot });
    checks.earlierPresenceIgnored = await ignored(run, JSON.stringify(late), late.pairingId);
    await peer.announce();
    const current = await peer.signal("offer", to.profileId);
    checks.currentBootAnswered = (await offered(run, current)) !== undefined;
    const lower = await peer.signal("offer", to.profileId, { sequence: current.sequence - 1 });
    checks.lowerSequenceIgnored = await ignored(run, JSON.stringify(lower), lower.pairingId);
    checks.higherSequenceAnswered = await control(run);
    checks.pairLinked = await pairLinked();
    return verdictOf(setup, checks);
  });

/** E5.a.duplicate: a repeated offer gets one answer, and a repeated answer changes nothing. */
export const duplicateSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const { peer, to } = run;
    const answers = () => writesOf(to, `answer-${LOWEST_ID}.json`);
    const first = await peer.signal("offer", to.profileId);
    const checks: Record<string, boolean> = {
      offerAnswered: (await offered(run, first)) !== undefined,
    };
    const before = await answers();
    await peer.write("offer", to.profileId, JSON.stringify(first));
    await quiet();
    await peer.write(
      "offer",
      to.profileId,
      JSON.stringify({ ...first, sequence: first.sequence + 1 }),
    );
    await quiet();
    const repeatedAnswers = (await answers()) - before;
    checks.oneAnswerPerOffer = repeatedAnswers === 0;
    const high = await listedVirtual(group, to, HIGHEST_ID);
    const offerPath = signalFile(group.downloads, to.profileId, "offer", HIGHEST_ID);
    const offer = await signalLands(offerPath, OFFER_MS);
    if (!offer) return verdictOf(setup, { ...checks, higherVirtualOffered: false });
    const answer = await high.signal("answer", to.profileId, { answering: offer.signal });
    await high.write("answer", to.profileId, JSON.stringify(answer));
    const pending = () => recordOf(to, "session", "pendingOffers", HIGHEST_ID);
    checks.answerAccepted =
      (await within(async () => ((await pending()) ? undefined : true), 10_000)) !== undefined;
    const acted = JSON.stringify(await recordOf(to, "session", "folderActed", HIGHEST_ID));
    await high.write("answer", to.profileId, JSON.stringify(answer));
    await high.write(
      "answer",
      to.profileId,
      JSON.stringify({ ...answer, sequence: answer.sequence + 1 }),
    );
    await quiet();
    checks.repeatedAnswerChangesNothing =
      JSON.stringify(await recordOf(to, "session", "folderActed", HIGHEST_ID)) === acted &&
      (await writesOf(to, `offer-${HIGHEST_ID}.json`)) === 1;
    checks.pairLinked = await pairLinked();
    return verdictOf(setup, checks, { repeatedAnswers });
  });

/** E5.a.expired (lab): an expired offer, or a peer whose presence expired, gets no answer. */
export const expiredSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const { peer, to } = run;
    const checks: Record<string, boolean> = { firstAnswered: await control(run) };
    const stale = await peer.signal("offer", to.profileId, { expiresAt: Date.now() - 1_000 });
    checks.expiredOfferIgnored = await ignored(run, JSON.stringify(stale), stale.pairingId);
    const third = await virtualIn(group, to, THIRD_ID);
    const thirdRun = beside(run, third);
    const now = Date.now();
    await third.writePresence(
      JSON.stringify(third.presence({ createdAt: now - 70_000, expiresAt: now - 10_000 })),
    );
    const refused = await catalogued(group, THIRD_ID);
    checks.expiredPresenceRefused = !refused.listed;
    const fromExpired = await third.signal("offer", to.profileId);
    checks.expiredPresenceOfferIgnored = await ignored(
      thirdRun,
      JSON.stringify(fromExpired),
      fromExpired.pairingId,
    );
    await third.announce();
    checks.freshPresenceListed = (await catalogued(group, THIRD_ID)).listed;
    checks.freshPresenceAnswered = await control(thirdRun);
    checks.lastAnswered = await control(run);
    checks.pairLinked = await pairLinked();
    return verdictOf(setup, checks, { catalogLog: refused.log });
  });

const reversed = (value: object) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).reverse()));

/** E5.a.corrupt (lab): a truncated, malformed, or self-contradicting offer gets no answer. */
export const corruptSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const { peer, to } = run;
    const next = () => peer.signal("offer", to.profileId);
    const checks: Record<string, boolean> = { firstAnswered: await control(run) };
    const cut = await next();
    checks.truncatedIgnored = await ignored(run, JSON.stringify(cut).slice(0, 120), cut.pairingId);
    const bad = await next();
    checks.badIdIgnored = await ignored(
      run,
      JSON.stringify({ ...bad, pairingId: "not-a-uuid" }),
      bad.pairingId,
    );
    const forged = await next();
    // The file names another pairing than its code, so vouched() refuses it.
    const contradicting = JSON.stringify({ ...forged, pairingId: randomUUID() });
    checks.contradictingIgnored = await ignored(run, contradicting, forged.pairingId);
    const reorder = await next();
    // JSON.parse reads keys in any order: a signal's order is not part of its contract.
    const reorderedAnswered =
      (await answerTo(run, reversed(reorder), reorder.pairingId, ANSWER_MS)) !== undefined;
    const third = await virtualIn(group, to, THIRD_ID);
    await third.writePresence(reversed(third.presence()));
    const refused = await catalogued(group, THIRD_ID);
    checks.reorderedPresenceRefused = !refused.listed;
    const fromThird = await third.signal("offer", to.profileId);
    const thirdRun = beside(run, third);
    checks.reorderedPresenceOfferIgnored = await ignored(
      thirdRun,
      JSON.stringify(fromThird),
      fromThird.pairingId,
    );
    checks.lastAnswered = await control(run);
    checks.pairLinked = await pairLinked();
    return verdictOf(setup, checks, { reorderedAnswered, catalogLog: refused.log });
  });

/** A third virtual peer stamped an hour ahead, an hour behind, then 3 s ahead of this clock. */
async function skewChecks(run: Facing) {
  const { group, to } = run;
  const third = await virtualIn(group, to, THIRD_ID);
  const thirdRun = beside(run, third);
  const stamped = (createdAt: number) =>
    third.writePresence(
      JSON.stringify(third.presence({ createdAt, expiresAt: createdAt + PRESENCE_TTL_MS })),
    );
  await stamped(Date.now() + HOUR_MS);
  const ahead = await catalogued(group, THIRD_ID);
  // Stamped by the clock its presence was, so it stays refused once that presence is set right.
  const aheadAt = Date.now() + HOUR_MS;
  const fromAhead = await third.signal("offer", to.profileId, {
    sequence: aheadAt,
    expiresAt: aheadAt + PAIRING_TTL_MS,
  });
  const aheadOfferIgnored = await ignored(thirdRun, JSON.stringify(fromAhead), fromAhead.pairingId);
  await stamped(Date.now() - HOUR_MS);
  const behind = await catalogued(group, THIRD_ID);
  await stamped(Date.now() + 3_000);
  const withinSkewListed = (await catalogued(group, THIRD_ID)).listed;
  const withinSkewMs = await offered(thirdRun, await third.signal("offer", to.profileId));
  const checks = {
    aheadRefused: !ahead.listed,
    aheadOfferIgnored,
    behindRefused: !behind.listed,
    withinSkewListed,
    withinSkewAnswered: withinSkewMs !== undefined,
    // As catalog.sh lists it, not once this clock caught up with its stamp.
    withinSkewPrompt: withinSkewMs !== undefined && withinSkewMs <= PROMPT_MS,
  };
  return { checks, logs: { aheadLog: ahead.log, behindLog: behind.log }, withinSkewMs };
}

/**
 * E5.a.clockChange: files stamped by a clock an hour off are refused by the documented bounds; the
 * OS clock itself cannot be changed in either environment, so the virtual peer's stamps move.
 */
export const clockChangeSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const { peer, to } = run;
    const firstAnswered = await control(run);
    const skew = await skewChecks(run);
    const checks: Record<string, boolean> = { firstAnswered, ...skew.checks };
    // A signal may live one pairing TTL and be stamped one clock skew ahead, no more.
    const farExpiry = await peer.signal("offer", to.profileId, { expiresAt: Date.now() + HOUR_MS });
    checks.farExpiryIgnored = await ignored(run, JSON.stringify(farExpiry), farExpiry.pairingId);
    const far = await peer.signal("offer", to.profileId, { sequence: Date.now() + HOUR_MS });
    checks.farSequenceIgnored = await ignored(run, JSON.stringify(far), far.pairingId);
    // A stamp that restarted at the stepped-back clock within the same boot.
    const reset = await peer.signal("offer", to.profileId, { sequence: Date.now() });
    checks.heardAfterStampReset = (await offered(run, reset)) !== undefined;
    peer.boot = randomUUID();
    await peer.announce();
    await quiet(SETTLE_MS);
    checks.nextBootAnswered = await control(run);
    checks.pairLinked = await pairLinked();
    return verdictOf(setup, checks, { withinSkewMs: skew.withinSkewMs, ...skew.logs });
  });

/** E5.a.readCache: each rewrite of one offer path is read and answered, never a cached copy. */
export const readCacheSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const setup = await facing(group);
    const { facing: run, pairLinked } = setup;
    const delays: (number | undefined)[] = [];
    for (let version = 0; version < 4; version++) {
      delays.push(await offered(run, await run.peer.signal("offer", run.to.profileId)));
    }
    const problems = delays.flatMap((ms, version) =>
      ms === undefined
        ? [`version ${version + 1} of the offer was not answered`]
        : ms > REREAD_MS
          ? [`version ${version + 1} was answered after ${ms} ms`]
          : [],
    );
    const linked = await pairLinked();
    return judged([...problems, ...(linked ? [] : ["the pair did not link"])], {
      delays,
      pairLinked: linked,
    });
  });
