import { setTimeout as delay } from "node:timers/promises";
import { listOf } from "../../e2e/fixtures/mesh.ts";
import {
  askPeers,
  isActive,
  linesWith,
  openTab,
  sendOverLink,
  tabOf,
  workOf,
} from "../../browser/fixtures/master-restart.ts";
import { backgroundLog, within } from "../../browser/fixtures/trust.ts";
import type { RoundClone, Round } from "./clone-round.ts";
import { sampleOf } from "./clones.ts";
import type { Sample } from "../outcome.ts";

/*
 * CL10 (POC PLAN.md P5.5): the master's Show tab and Record on A and on B each leave one command and
 * one result on the wire, a worker's command on another worker or on the master is refused by the
 * bound-master rule, and no refused command activates anything. Where the master is not attached
 * (the host), the refusals are read in the clones' logs only.
 */

const LOGGED_MS = 20_000;
// A duplicate result would arrive within a few polls of the first.
const QUIET_MS = 3_000;

const count = (log: string[], text: string, from: number) => linesWith(log, text, from).length;

/** `text` appears in `log` from `from` on, waiting for it. */
const appears = (log: string[], text: string, from: number) =>
  within(async () => (count(log, text, from) > 0 ? true : undefined), LOGGED_MS);

/** The master's Show tab on `clone`: the clone activates the tab, the master logs one result. */
async function showTab(round: Round, clone: RoundClone, masterLog: string[]): Promise<string[]> {
  const { master } = round.host;
  const view = master.view;
  if (!view) return [];
  const url = new URL(`/privacy/?show-${clone.name}`, round.host.baseURL).href;
  const [from, cloneFrom] = [masterLog.length, clone.log.length];
  const tab = await openTab(clone.profile, url);
  const item = listOf(view, clone.view).getByRole("listitem").filter({ hasText: url });
  await item.getByRole("button", { name: "Show tab" }).click();
  const active = await within(
    async () => ((await isActive(clone.profile, tab)) ? true : undefined),
    LOGGED_MS,
  );
  await appears(masterLog, "received COMMAND_RESULT", from);
  await delay(QUIET_MS);
  return [
    ...(active ? [] : [`${clone.name} did not show the tab`]),
    ...expectOnce(masterLog, from, ["sent ACTIVATE_TAB", "received COMMAND_RESULT"], "master"),
    ...expectOnce(
      clone.log,
      cloneFrom,
      ["received ACTIVATE_TAB", "sent COMMAND_RESULT"],
      clone.name,
    ),
  ];
}

/** Each text exactly once in `log` from `from` on. */
function expectOnce(log: string[], from: number, texts: string[], who: string): string[] {
  return texts.flatMap((text) => {
    const seen = count(log, text, from);
    return seen === 1 ? [] : [`${who} logged "${text}" ${seen} times`];
  });
}

/** The master's Record on `clone`: a session starts in its tab, then one command stops it. */
async function record(round: Round, clone: RoundClone, masterLog: string[]): Promise<string[]> {
  const page = round.host.master.view?.dashboard;
  if (!page) return [];
  const from = masterLog.length;
  const tabId = await tabOf(clone.profile, `${clone.name} record`);
  const started = await askPeers(page, { type: "session-start", peer: clone.id, tabId });
  const work = await workOf(clone.profile);
  const stopped = await askPeers(page, { type: "session-stop", peer: clone.id });
  await delay(QUIET_MS);
  return [
    ...(started.ok ? [] : [`session-start: ${JSON.stringify(started)}`]),
    ...(work.controlledBy === round.host.master.profileId
      ? []
      : [`${clone.name} was controlled by ${work.controlledBy}`]),
    ...(stopped.ok ? [] : [`session-stop: ${JSON.stringify(stopped)}`]),
    ...expectOnce(masterLog, from, ["sent SESSION_START"], "master"),
    ...(count(masterLog, "received COMMAND_RESULT", from) === 2
      ? []
      : ["master logged other than two results"]),
  ];
}

/** `from` sends a command to `to` over its link; `receiver`'s log shows the refusal and the tab stays behind. */
async function refused(
  from: RoundClone,
  to: { profileId: string; name: string; log: string[] },
  tab: () => Promise<[number, () => Promise<boolean>]>,
) {
  const [tabId, active] = await tab();
  const start = to.log.length;
  await sendOverLink(from.profile, to, { type: "ACTIVATE_TAB", tabId });
  const line = `REFUSED ACTIVATE_TAB from ${from.id}: not the bound master`;
  const seen = await appears(to.log, line, start);
  return [
    ...(seen ? [] : [`${to.name} did not log: ${line}`]),
    ...((await active()) ? [`${to.name}'s tab was activated`] : []),
  ];
}

/** CL10: commands from the master, and refusals of the others. */
export async function commandsCell(round: Round): Promise<Sample> {
  const { master } = round.host;
  const [a, b] = round.clones;
  if (!a || !b) throw new Error("A round holds A and B.");
  const masterLog = master.profile ? backgroundLog(master.profile.context) : [];
  const problems: string[] = [];
  for (const clone of round.clones) {
    problems.push(
      ...(await showTab(round, clone, masterLog)),
      ...(await record(round, clone, masterLog)),
    );
  }
  const behind = (clone: RoundClone) => async (): Promise<[number, () => Promise<boolean>]> => {
    const tabId = await tabOf(clone.profile, `${clone.name} behind`);
    return [tabId, () => isActive(clone.profile, tabId)];
  };
  problems.push(...(await refused(a, { profileId: b.id, name: b.name, log: b.log }, behind(b))));
  if (master.profile) {
    const mp = master.profile;
    const tab = async (): Promise<[number, () => Promise<boolean>]> => {
      const tabId = await tabOf(mp, "master behind");
      return [tabId, () => isActive(mp, tabId)];
    };
    problems.push(
      ...(await refused(b, { profileId: mp.profileId, name: "master", log: masterLog }, tab)),
    );
  }
  return sampleOf(problems, {
    masterAttached: master.profile !== undefined,
    masterLines: masterLog.length,
  });
}
