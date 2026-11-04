import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chainProblems, chainSeen, labelled } from "./e8-chain.ts";
import type { ChainExpected, ChainObserved } from "./e8-chain.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import type { Sample, VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import { NAMESPACE, runDiscovery } from "./fixtures/e8-discovery.ts";
import { recordText } from "./fixtures/e4-launcher.ts";
import type { RecordEntry } from "./fixtures/e4-launcher.ts";
import type { E4Environment, E4Session } from "./fixtures/e4-profiles.ts";
import { announced, discover, withSession } from "./fixtures/e4-run.ts";
import type { Labels, Peer } from "./fixtures/e4-run.ts";
import { recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";

/*
 * The samples of E8's Downloads-root cells (POC PLAN.md P4.2), shared by the lab spec and its host
 * twin: each starts real profiles, lets the extension publish a presence carrying the launcher's
 * token, and runs discovery.sh's chain on it.
 */

// A profile directory the root does not have: its Preferences read yields nothing, as a key absent.
const ABSENT_PROFILE = "Profile 9";
const OS_DEFAULT = "<OS default>";

/** Each cell and its topology: the profiles and folders it starts, never a path. */
export const E8_CELLS = {
  "E8.root.preferences": "one profile on a custom folder its Preferences name",
  "E8.root.osDefault": "one profile on the OS default, found with no other step naming it",
  "E8.root.record": "one profile on a folder only the launcher record names",
  "E8.root.find": "one profile on a folder under HOME that no earlier step names",
  "E8.root.notFound": "one profile on a folder whose presence carries another boot",
} as const;
export type E8Hypothesis = keyof typeof E8_CELLS;

async function e8Cell(hypothesis: E8Hypothesis, target: VerdictTarget): Promise<Cell> {
  return {
    experiment: "E8",
    hypothesis,
    chrome: await target.chrome(),
    environment: target.environment,
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology: E8_CELLS[hypothesis],
    debugger: "none",
  };
}

/** Records one E8 verdict through outcome.ts, in the target's verdicts folder. */
export async function recordE8(
  hypothesis: E8Hypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) {
  const directory = target.directory?.();
  const options = directory === undefined ? {} : { directory };
  return recordHypothesis(await e8Cell(hypothesis, target), take, options);
}

/** A HOME for the chain: a fresh folder, or the lab's own home so Chrome's real default is under it. */
async function homeOf(session: E4Session, labels: Labels, realDefault: boolean) {
  const home = realDefault ? dirname(session.defaultDownloads) : await session.folder("home");
  labels.set(home, "<home>").set(join(home, "Downloads"), OS_DEFAULT);
  return home;
}

/** A profile on `downloads` whose worker published a presence carrying a token the launcher opened. */
async function tokened(session: E4Session, labels: Labels, downloads?: string) {
  const peer = await announced(session, "P", downloads);
  const found = await discover(session, peer, { candidates: [peer.downloads], labels });
  if (found.matches.length === 0) throw new Error("P's token reached no presence in its folder");
  return { peer, token: found.token, opened: found.observation.opened };
}

interface Run {
  session: E4Session;
  labels: Labels;
  home: string;
  peer: Peer;
  profileDirectory: string;
  token: string;
  expected: ChainExpected;
}

/** Runs the chain and each of its steps on their own; a step that fails to run is the harness's. */
async function observed(run: Run): Promise<ChainObserved & { chainMs: number }> {
  const { session, labels, home, peer, profileDirectory, token } = run;
  const root = peer.profile.root;
  const common = [root, profileDirectory, session.record, NAMESPACE];
  const step = async (command: string, args: readonly string[]) => {
    const result = await runDiscovery(home, command, args);
    if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${result.stderr}`);
    return labelled(result.stdout, labels);
  };
  const started = performance.now();
  const chain = await runDiscovery(home, "profile_downloads_root", [...common, token]);
  const chainMs = Math.round(performance.now() - started);
  return {
    chain: chainSeen(chain, labels),
    chainMs,
    candidates: await step("downloads_root_candidates", common),
    steps: {
      preferences: (await step("pref_download_dir", [root, profileDirectory]))[0] ?? null,
      record: await step("record_roots", [session.record]),
      find: await step("find_presences", [home, NAMESPACE]),
    },
  };
}

/** The sample of a run: the chain and its steps against what the cell expects. */
async function judgedRun(run: Run, entries: RecordEntry[]): Promise<Sample> {
  await writeFile(run.session.record, recordText(entries));
  const { chainMs, ...seen } = await observed(run);
  return judged(chainProblems(seen, run.expected), { ...seen, chainMs });
}

const profileEntry = (peer: Peer, downloadsRoot?: string): RecordEntry => ({
  userDataDir: peer.profile.root,
  profileId: peer.profileId,
  ...(downloadsRoot ? { downloadsRoot } : {}),
});

const noSteps = { preferences: null, record: [], find: [] };

/** E8.root.preferences: the Preferences name a custom folder, so step 1 gives it. */
export const preferencesSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const home = await homeOf(session, labels, false);
    const own = await session.folder("own");
    labels.set(own, "<custom folder>");
    const { peer, token } = await tokened(session, labels, own);
    // Chrome writes Preferences when it quits; the launcher reads them before it opens a profile.
    await session.quit(peer.profile);
    const expected = {
      found: "<custom folder>",
      candidates: ["<custom folder>", OS_DEFAULT],
      steps: { ...noSteps, preferences: "<custom folder>" },
    };
    const run = { session, labels, home, peer, profileDirectory: "Default", token, expected };
    return judgedRun(run, [profileEntry(peer)]);
  });

/** E8.root.osDefault: the key absent, the presence under the OS default, so step 2 gives it. */
export const osDefaultSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const home = await homeOf(session, labels, session.realDefault);
    // The host's Chrome gets the stand-in in its Preferences, so the chain reads a profile it lacks.
    if (!session.realDefault) await mkdir(join(home, "Downloads"));
    const downloads = session.realDefault ? undefined : join(home, "Downloads");
    const { peer, token } = await tokened(session, labels, downloads);
    const profileDirectory = session.realDefault ? "Default" : ABSENT_PROFILE;
    const expected = {
      found: OS_DEFAULT,
      candidates: [OS_DEFAULT],
      steps: { ...noSteps, find: [OS_DEFAULT] },
    };
    const run = { session, labels, home, peer, profileDirectory, token, expected };
    return judgedRun(run, [profileEntry(peer)]);
  });

/** E8.root.record: a folder only the record names, so step 3 gives it. */
export const recordSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const home = await homeOf(session, labels, false);
    const named = await session.folder("recorded");
    labels.set(named, "<record folder>");
    const { peer, token } = await tokened(session, labels, named);
    const expected = {
      found: "<record folder>",
      candidates: [OS_DEFAULT, "<record folder>"],
      steps: { ...noSteps, record: ["<record folder>"] },
    };
    const run = { session, labels, home, peer, profileDirectory: ABSENT_PROFILE, token, expected };
    return judgedRun(run, [profileEntry(peer, named)]);
  });

/** E8.root.find: a folder under HOME that no earlier step names, so only the bounded find gives it. */
export const findSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const home = await homeOf(session, labels, false);
    const under = join(home, "Documents", "work");
    await mkdir(under, { recursive: true });
    labels.set(under, "<folder under home>");
    const { peer, token } = await tokened(session, labels, under);
    const expected = {
      found: "<folder under home>",
      candidates: [OS_DEFAULT, "<folder under home>"],
      steps: { ...noSteps, find: ["<folder under home>"] },
    };
    const run = { session, labels, home, peer, profileDirectory: ABSENT_PROFILE, token, expected };
    return judgedRun(run, [profileEntry(peer)]);
  });

/** E8.root.notFound: the only presence carries the extension's own boot, not the token asked for. */
export const notFoundSample = (environment: E4Environment) =>
  withSession(environment, async (session, labels) => {
    const home = await homeOf(session, labels, false);
    const own = await session.folder("own");
    const named = await session.folder("recorded");
    labels.set(own, "<custom folder>").set(named, "<record folder>");
    // The launcher never opened this profile with the token it asks for: its presence is the decoy.
    const peer = await announced(session, "P", own);
    await session.quit(peer.profile);
    const candidates = ["<custom folder>", OS_DEFAULT, "<record folder>"];
    const expected = {
      found: null,
      candidates,
      steps: { ...noSteps, preferences: "<custom folder>", record: ["<record folder>"] },
    };
    const run = {
      session,
      labels,
      home,
      peer,
      profileDirectory: "Default",
      token: randomUUID(),
      expected,
    };
    return judgedRun(run, [profileEntry(peer, named)]);
  });
