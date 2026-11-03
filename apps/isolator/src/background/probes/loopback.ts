import type { ProbeTargets, TargetInfo } from "@/background/probes/types";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** What a route records for a target it leaves untouched because it is outside the loopback. */
export const REFUSED = "refused: not on the loopback";

/** R11 (POC PLAN.md §1): an http(s) URL on the loopback, which Chrome resolves *.localhost to. */
export function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname } = new URL(value);
  if (protocol !== "http:" && protocol !== "https:") return false;
  return LOOPBACK_HOSTS.includes(hostname) || hostname.endsWith(".localhost");
}

/** The harness passes the fixture URLs; the probes hand them to Chrome, so only the loopback passes. */
export function assertLoopbackTargets(urls: ProbeTargets): void {
  const outside = Object.entries(urls).filter(([, url]) => !isLoopbackUrl(String(url)));
  if (outside.length === 0) return;
  const list = outside.map(([key, url]) => `${key}=${String(url)}`).join(", ");
  throw new Error(`probe targets outside the loopback: ${list}`);
}

/** R11: the isolator attaches to, evaluates in, or stops nothing outside the loopback. */
export function requireLoopback(what: string, url: string): void {
  if (!isLoopbackUrl(url))
    throw new Error(`refuses ${what} at ${url}, which is not on the loopback`);
}

export function pageOf(targets: TargetInfo[], tabId: number): TargetInfo {
  const page = targets.find((target) => target.type === "page" && target.tabId === tabId);
  if (!page) throw new Error(`no tab ${tabId}`);
  return page;
}

function targetOf(targets: TargetInfo[], targetId: string): TargetInfo {
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`no target ${targetId}`);
  return target;
}

/** The page of tab `tabId`, refused when it is gone or outside the loopback. */
export function loopbackPage(targets: TargetInfo[], tabId: number): TargetInfo {
  const page = pageOf(targets, tabId);
  requireLoopback(`tab ${tabId}`, page.url);
  return page;
}

/** A tab with no document origin yet: `about:blank`, with or without a fragment. */
function isBlankUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).href.split("#")[0] === "about:blank";
}

/** The page to arm: arming precedes the navigation that starts a worker, so a blank tab passes too. */
export function armablePage(targets: TargetInfo[], tabId: number): TargetInfo {
  const page = pageOf(targets, tabId);
  if (!isBlankUrl(page.url)) requireLoopback(`tab ${tabId}`, page.url);
  return page;
}

/** The target `targetId`, refused when it is gone or outside the loopback. */
export function loopbackTargetOf(targets: TargetInfo[], targetId: string): TargetInfo {
  const target = targetOf(targets, targetId);
  requireLoopback(`target ${targetId}`, target.url);
  return target;
}
