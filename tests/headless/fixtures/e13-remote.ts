import type { Page } from "@playwright/test";
import { askPeers } from "../../browser/fixtures/master-restart.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import type { Sample } from "../../experiments/outcome.ts";
import type { Site } from "./e13-site.ts";

/*
 * What the master does to a headless worker with peer commands only (POC PLAN.md P7.4): it asks
 * the worker to open the static test page (OPEN_TAB), then reads what the worker reports of its
 * tabs and what the static server saw. The echoed url and the command's ack prove nothing: the
 * page is proven by the worker's own new tab titled with a marker no earlier call used and by the
 * server's log of that marker since the call began.
 */

const READ_MS = 90_000;

interface Tab {
  id: number;
  title?: string;
  url?: string;
}

/** The master's dashboard page, which asks, and the site the workers load. */
export interface Remote {
  dashboard: Page;
  site: Site;
}

/** A worker as the master knows it, and the marker its page carries. */
export interface Target {
  name: string;
  profileId: string;
  marker: string;
}

/** The tabs `peer` last reported to the master; empty when the request fails. */
async function tabsOf(page: Page, peer: string): Promise<Tab[]> {
  const reply = await askPeers(page, { type: "tabs", peer });
  return reply.ok ? ((reply.result as { tabs?: Tab[] }).tabs ?? []) : [];
}

interface Opened {
  /** The fresh marker of this call: the worker's marker plus a nonce no earlier call used. */
  marker: string;
  /** The worker's new tab, titled with the fresh marker; undefined when none showed up. */
  tab?: Tab;
  /** The tabs the worker reported at the end. */
  tabs: Tab[];
  /** Paths of the static server requests for the fresh marker made since the call began, in order. */
  requests: string[];
  error?: string;
}

let calls = 0;

/** Letters and digits only, since the site serves any such id. */
const freshMarker = (base: string) => `${base}n${(++calls).toString(36)}${Date.now().toString(36)}`;

const requestsOf = (site: Site, marker: string, since: number) =>
  site.seen
    .filter((seen) => seen.at >= since && seen.path.endsWith(`/${marker}`))
    .map((seen) => seen.path);

/** Every completion needs this call's start page first and then the marker page it navigates to. */
function requestProblems(name: string, marker: string, requests: string[]): string[] {
  const start = requests.indexOf(`/start/${marker}`);
  const reached = requests.indexOf(`/marker/${marker}`);
  if (start === 0 && reached > start) return [];
  return [`${name}: the server saw ${requests.join(", ") || "nothing"} for this call's pages`];
}

/** Asks `target` to open a page with a marker of its own and waits for the new tab that carries it. */
async function markerTab(remote: Remote, target: Target): Promise<Opened> {
  const { dashboard, site } = remote;
  const marker = freshMarker(target.marker);
  const title = site.titleOf(marker);
  const since = Date.now();
  const before = new Set((await tabsOf(dashboard, target.profileId)).map((tab) => tab.id));
  const fresh = async () => {
    const tabs = await tabsOf(dashboard, target.profileId);
    const tab = tabs.find((candidate) => candidate.title === title && !before.has(candidate.id));
    return tab ? { tab, tabs } : undefined;
  };
  const asked = await askPeers(dashboard, {
    type: "open-tab",
    peer: target.profileId,
    url: site.startUrl(marker),
  });
  const error = asked.ok ? undefined : asked.error;
  const found = error === undefined ? await within(fresh, READ_MS) : undefined;
  const tabs = found?.tabs ?? (await tabsOf(dashboard, target.profileId));
  const requests = requestsOf(site, marker, since);
  return {
    marker,
    ...(found ? { tab: found.tab } : {}),
    tabs,
    requests,
    ...(error ? { error } : {}),
  };
}

/** Opens a fresh page in every target; `problems` says what the master could not see. */
async function openAll(remote: Remote, targets: Target[]) {
  const problems: string[] = [];
  const opened = new Map<Target, Opened>();
  for (const target of targets) {
    const result = await markerTab(remote, target);
    opened.set(target, result);
    if (result.error) {
      problems.push(`${target.name}: open-tab refused: ${result.error}`);
      continue;
    }
    if (!result.tab)
      problems.push(`${target.name}: no new tab titled ${remote.site.titleOf(result.marker)}`);
    problems.push(...requestProblems(target.name, result.marker, result.requests));
  }
  return { problems, opened };
}

/** commands: the master opens the page in each worker, then activates the tab the worker reported. */
export async function commandsSample(remote: Remote, targets: Target[]): Promise<Sample> {
  const { problems, opened } = await openAll(remote, targets);
  const replies: unknown[] = [];
  for (const [target, result] of opened) {
    if (!result.tab) continue;
    const reply = await askPeers(remote.dashboard, {
      type: "activate",
      peer: target.profileId,
      tabId: result.tab.id,
    });
    replies.push({
      name: target.name,
      tab: result.tab.title,
      requests: result.requests,
      activate: reply.ok ? "ok" : reply.error,
    });
    if (!reply.ok) problems.push(`${target.name}: activate refused: ${reply.error}`);
  }
  return judged(problems, { replies });
}

/** tabs: each worker lists the fresh tab, and the bootstrap page of its own is not shared. */
export async function tabsSample(remote: Remote, targets: Target[]): Promise<Sample> {
  const { problems, opened } = await openAll(remote, targets);
  const listed: unknown[] = [];
  for (const [target, result] of opened) {
    listed.push({
      name: target.name,
      requests: result.requests,
      tabs: result.tabs.map((tab) => tab.title),
    });
    if (result.tabs.some((tab) => (tab.url ?? "").includes("bootstrap.html")))
      problems.push(`${target.name}: the bootstrap page is shared`);
  }
  return judged(problems, { listed });
}

/** navigation: the server saw the start page, then the marker page; the worker reports the marker url. */
export async function navigationSample(remote: Remote, targets: Target[]): Promise<Sample> {
  const { problems, opened } = await openAll(remote, targets);
  const navigated: unknown[] = [];
  for (const [target, result] of opened) {
    navigated.push({
      name: target.name,
      marker: result.marker,
      requests: result.requests,
      url: result.tab?.url,
    });
    if (result.tab && result.tab.url !== remote.site.markerUrl(result.marker))
      problems.push(`${target.name}: the worker reports ${result.tab.url}`);
  }
  return judged(problems, { navigated });
}

/** marker: each worker reports its own marker and no other worker's. */
export async function markerSample(remote: Remote, targets: Target[]): Promise<Sample> {
  const { problems, opened } = await openAll(remote, targets);
  const titles: unknown[] = [];
  for (const [target, result] of opened) {
    // Earlier calls left tabs of this worker, titled with its marker and an older nonce.
    const own = remote.site.titleOf(target.marker);
    const foreign = result.tabs.filter(
      (tab) => (tab.title ?? "").startsWith("marker:") && !(tab.title ?? "").startsWith(own),
    );
    titles.push({
      name: target.name,
      own: Boolean(result.tab),
      requests: result.requests,
      foreign: foreign.length,
    });
    if (foreign.length > 0) problems.push(`${target.name}: reports another worker's marker`);
  }
  return judged(problems, { titles });
}
