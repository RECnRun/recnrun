import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";
import { presenceIn, writePresence } from "./fixtures/e4-launcher.ts";
import type { Sample, VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import type { E4Environment } from "./fixtures/e4-profiles.ts";
import { readRegistryIn } from "./fixtures/e4-profiles.ts";
import {
  announced,
  catalogEach,
  discover,
  discoverAndPublish,
  labelOf,
  names,
  published,
  runSummary,
  withSession,
} from "./fixtures/e4-run.ts";

/*
 * The samples of E4 (POC PLAN.md P2.1), shared by the lab spec and its host twin: one per cell
 * E4.<hypothesis>.<layout>, each on its own profiles and folders.
 */

// PRESENCE_TTL_MS of apps/extension/src/p2p/folder-rendezvous.ts.
const PRESENCE_TTL_MS = 60_000;
const CUSTOM_REASON = "root outside the scanned candidates";
export const PREFERENCES_REASON = "no native reader on Linux";

/** Each cell and its topology: the profiles and folders it starts, never a path. */
export const E4_CELLS = {
  "E4.a.commonRoot": "two profiles, OS default",
  "E4.b.differentRoots": "two profiles, OS default and a launcher folder",
  "E4.b.customRoot": "two profiles, OS default and an unrecorded custom folder",
  "E4.b.closedProfile": "two profiles, OS default, one quit",
  "E4.c.preferences": "one profile on its own folder, one on the OS default where real",
  "E4.d.manualPath": "two profiles, two typed folders",
} as const;
export type E4Hypothesis = keyof typeof E4_CELLS;

export async function e4Cell(hypothesis: E4Hypothesis, target: VerdictTarget): Promise<Cell> {
  return {
    experiment: "E4",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: E4_CELLS[hypothesis],
    debugger: "none",
  };
}

/** Records one E4 verdict through outcome.ts, in the target's verdicts folder. */
export async function recordE4(
  hypothesis: E4Hypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const directory = target.directory?.();
  const options = directory === undefined ? {} : { directory };
  return recordHypothesis(await e4Cell(hypothesis, target), take, options);
}

/** E4.a: two profiles that both download to the OS default; the scan of that one folder finds both. */
export const commonRootSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const peers = [await announced(session, "A"), await announced(session, "B")];
    return discoverAndPublish(session, peers, [session.defaultDownloads], labels);
  });

/**
 * E4.b: A on the OS default, B on a folder the launcher created and keeps in its record as a root
 * with no profile bound to it; the launcher learns which profile is on which root from the tokens.
 */
export const differentRootsSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const created = await session.folder("created");
    labels.set(created, "<launcher folder>");
    const peers = [await announced(session, "A"), await announced(session, "B", created)];
    const record = [session.defaultDownloads, created];
    return discoverAndPublish(session, peers, record, labels);
  });

/**
 * E4.b limit: B downloads to a folder its owner chose, which neither the OS default nor the record
 * names, so the scan cannot find its token; the harness checks the token did land in that folder.
 */
export const customRootSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const custom = await session.folder("custom");
    labels.set(custom, "<custom folder>");
    const a = await announced(session, "A");
    const b = await announced(session, "B", custom);
    const scanned = [session.defaultDownloads];
    const foundA = await discover(session, a, scanned, labels);
    const foundB = await discover(session, b, scanned, labels);
    const landed = (await presenceIn(custom, b.profileId))?.boot === foundB.token;
    const discovery = { A: foundA.observation, B: foundB.observation };
    const observation = { discovery, tokenInCustom: landed };
    if (foundB.root) return judged([], observation);
    return judged([landed ? CUSTOM_REASON : "B's token reached no folder"], observation);
  });

/**
 * E4.b limit: a profile its owner closed stays listed until its presence expires; the sample writes
 * an already expired presence instead of waiting PRESENCE_TTL_MS, and records what catalog.sh does.
 */
export const closedProfileSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const a = await announced(session, "A");
    const b = await announced(session, "B");
    const root = session.defaultDownloads;
    const entries = [a, b].map((peer) => ({
      userDataDir: peer.profile.root,
      profileId: peer.profileId,
      downloadsRoot: root,
    }));
    await session.quit(b.profile);
    const catalogOnce = async () => {
      const run = (await catalogEach(session, entries)).runs.get(root);
      if (!run) throw new Error("catalog.sh did not run for the common root");
      return runSummary(run, [a, b], labels);
    };
    const afterQuit = await catalogOnce();
    const last = await presenceIn(root, b.profileId);
    if (!last) throw new Error("B's presence is gone after its Chrome quit");
    const now = Date.now();
    await writePresence(root, {
      ...last,
      createdAt: now - PRESENCE_TTL_MS - 2_000,
      expiresAt: now - 2_000,
    });
    const afterExpiry = await catalogOnce();
    const own = await readRegistryIn(a.profile);
    const read = {
      reason: own.reason,
      listed: names(
        [a, b],
        own.peers.map((peer) => peer.profileId),
      ),
    };
    const problems = [
      ...(afterExpiry.code === 0 ? [] : [`catalog.sh exited ${afterExpiry.code}`]),
      ...(afterExpiry.listed.join(",") === "A"
        ? []
        : [`after expiry it lists ${afterExpiry.listed.join(",")}`]),
      ...(read.listed.join(",") === "A" ? [] : [`A reads ${read.listed.join(",")}`]),
    ];
    return judged(problems, { afterQuit, afterExpiry, readByA: read });
  });

/** download.default_directory of a root as JSON.parse reads it, or null when it is absent. */
async function jsonPreference(root: string): Promise<string | null> {
  const text = await readFile(join(root, "Default", "Preferences"), "utf8");
  const value: unknown = (JSON.parse(text) as { download?: { default_directory?: unknown } })
    .download?.default_directory;
  return typeof value === "string" ? value : null;
}

/**
 * E4.c: a profile on its own folder (P), and in the lab one on the OS default (Q), quit so Chrome
 * writes Preferences; `reader` is the launcher's native reader of P's, or undefined where none exists.
 */
export const preferencesSample = (
  environment: E4Environment,
  reader?: (root: string) => Promise<string | null>,
) =>
  withSession(environment, async (session, labels) => {
    const own = await session.folder("own");
    labels.set(own, "<own folder>");
    const p = await announced(session, "P", own);
    labels.set(p.profile.root, "<root P>");
    const peers = session.realDefault ? [p, await announced(session, "Q")] : [p];
    const json: Record<string, string | null> = {};
    for (const peer of peers) {
      await session.quit(peer.profile);
      json[peer.profile.name] = labelOf(labels, await jsonPreference(peer.profile.root));
    }
    if (!reader) return judged([], { json });
    // A reader that fails to run is a harness error; only an UnavailableError marks the method absent.
    const native = { value: labelOf(labels, await reader(p.profile.root)) };
    const problems =
      native.value === "<own folder>" ? [] : [`the native reader read ${native.value}`];
    return judged(problems, { json, native });
  });

/** E4.d control: the owner types each profile's Downloads folder into the record by hand. */
export const manualPathSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const [first, second] = [await session.folder("typed-a"), await session.folder("typed-b")];
    labels.set(first, "<typed folder A>").set(second, "<typed folder B>");
    const peers = [await announced(session, "A", first), await announced(session, "B", second)];
    const entries = peers.map((peer) => ({
      userDataDir: peer.profile.root,
      downloadsRoot: peer.downloads,
    }));
    const { runs, ids } = await catalogEach(session, entries);
    const result = await published(peers, runs, labels);
    const rootIdsByLabel = Object.fromEntries(
      [...ids].map(([path, id]) => [labelOf(labels, path), id]),
    );
    return judged(result.problems, {
      rootIds: rootIdsByLabel,
      catalog: result.catalog,
      reads: result.reads,
    });
  });
