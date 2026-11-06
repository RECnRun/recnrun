import { setTimeout as delay } from "node:timers/promises";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup } from "../browser/fixtures/downloads-profiles.ts";
import { arrive, arriving } from "./fixtures/e5-run.ts";
import { measured, meter } from "./fixtures/e7-downloads.ts";
import type { Policy } from "./fixtures/e7-downloads.ts";

/*
 * E7's newcomer probe (Codex P3 finding 2): four profiles link under a silent policy, every
 * presence expires, then a fifth fresh profile starts. The catalog lists only what has an unexpired
 * presence, so the newcomer reads nobody until the survivors write one again.
 */

const PRESENCE_TTL_MS = 60_000;
const SKEW_MS = 10_000;
const LINK_MS = 90_000;
const LATE_NAME = "Worker 4";

/** How many profiles the catalog lists with an unexpired presence now. */
async function listedCount(group: DownloadsGroup) {
  const peers = (await group.catalog()).registry?.peers ?? {};
  return Object.values(peers).filter((peer) => peer.expiresAt > Date.now()).length;
}

/** A fifth profile after every presence of four linked ones expired: whether it links, and what that cost. */
export async function newcomer(group: DownloadsGroup, policy: Policy) {
  const { profiles: survivors } = await arrive(group, 4);
  await waitForMesh(survivors);
  for (const profile of survivors) await meter(profile, policy);
  await delay(PRESENCE_TTL_MS + SKEW_MS);
  const listedBefore = await listedCount(group);
  const startedAt = Date.now();
  const fifth = await arriving(group, LATE_NAME);
  const linkedMs = await waitForMesh([...survivors, fifth], LINK_MS).catch(() => undefined);
  const counts = await Promise.all(survivors.map(measured));
  const survivorLinks = await Promise.all(survivors.map((each) => linkedPeers(each)));
  const renewalCost = {
    presenceDownloads: counts.reduce((sum, count) => sum + count.presenceCalls, 0),
    otherDownloads: counts.reduce((sum, count) => sum + count.signalCalls + count.otherCalls, 0),
    perSurvivor: counts.map((count) => count.presenceCalls),
  };
  const problems = [
    ...(listedBefore > 0 ? [`the catalog still listed ${listedBefore} before the newcomer`] : []),
    ...(linkedMs === undefined
      ? [`the newcomer did not link with all four within ${LINK_MS} ms`]
      : []),
    ...(survivorLinks.some((peers) => peers.length < 3) ? ["a survivor lost a link"] : []),
  ];
  return {
    problems,
    observation: {
      policy,
      presenceTtlMs: PRESENCE_TTL_MS,
      waitedMs: PRESENCE_TTL_MS + SKEW_MS,
      listedBeforeNewcomer: listedBefore,
      linkedMs,
      sinceStartMs: Date.now() - startedAt,
      renewalCost,
    },
  };
}
