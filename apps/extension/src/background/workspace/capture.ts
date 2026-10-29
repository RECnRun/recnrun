import { approximateBytes } from "@recnrun/domain";
import type { IdentityCapture, ManagedWindowState, SkippedOrigin } from "@recnrun/domain";
import type { BarrierOperation } from "@/background/workspace/barrier";
import type { BootstrapPorts } from "@/background/workspace/bootstrap";
import type { CaptureApi } from "@/background/workspace/capture-api";
import { captureCookies } from "@/background/workspace/cookie-capture";
import { resolveTabStore } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import type { HelperDeps } from "@/background/workspace/helper-tab";
import { CAPTURE_BOUND_MS, originReader, readOthers } from "@/background/workspace/origin-reads";
import type { OriginRead, OthersRead } from "@/background/workspace/origin-reads";
import { openPrimary } from "@/background/workspace/primary-read";
import type { PrimaryAccess } from "@/background/workspace/primary-read";
import { findSessionTabs, readLayout } from "@/background/workspace/session-tabs";
import type { LayoutRead, SessionTabs } from "@/background/workspace/session-tabs";
import { readTabOrigins, returnTabs } from "@/background/workspace/tab-origins";
import type { MovedTab } from "@/background/workspace/tab-origins";
import type { CapturedCounts } from "@/messaging/origin-protocol";
import type { VisitedOrigins } from "@/ports/visited-origins";
import type { IdentityCaptures } from "@/storage/identity-captures";

export interface CaptureDeps {
  api: CaptureApi;
  captures: Pick<
    IdentityCaptures,
    "begin" | "append" | "dropParts" | "publish" | "discard" | "read"
  >;
  cookies: Pick<CookieApi, "stores" | "normalTabIds" | "all">;
  /** The other origins the session visited, each tab's own, and the helper tab they load in. */
  origins: {
    visits: Pick<VisitedOrigins, "visited" | "tabVisits" | "focusedWindow">;
    helper: HelperDeps;
  };
  boundMs?: number;
  /** Set when the session's windows close after the capture, so the tabs it moved stay as they are. */
  closing?: boolean;
}

/** A published capture's size and duration, never its values. */
export interface CaptureSummary {
  captureId: string;
  localStorage: number;
  sessionStorage: number;
  databases: number;
  records: number;
  caches: number;
  cacheEntries: number;
  cookies: number;
  unsupported: number;
  /** The visited origins this capture left out or kept from the last one, by origin and step. */
  skipped: SkippedOrigin[];
  /** The approximate size of what was kept, as the dashboard shows it. */
  bytes: number;
  ms: number;
  /** Every tab of the session the capture saw, so the close can refuse one opened since. */
  tabs: number[];
  /** The tabs a closing capture left off their page; whatever stops the close brings them back. */
  away: MovedTab[];
}

interface Target {
  tabId: number;
  origin: string;
  url: string;
  /** The tab's Incognito cookie store. */
  storeId: string;
}

type Jar = IdentityCapture["cookies"];

async function targetOf(deps: CaptureDeps, tab: SessionTabs["primary"]): Promise<Target> {
  const { tabId, origin, url } = tab;
  const storeId = await resolveTabStore(deps.cookies, tabId);
  return { tabId, origin, url, storeId };
}

function startedHeader(identityId: string, target: Target): IdentityCapture {
  return {
    formatVersion: 1,
    id: crypto.randomUUID(),
    identityId,
    url: target.url,
    status: "in-progress",
    startedAt: Date.now(),
    adapters: [],
    valueTypes: [],
    cookies: [],
    origins: [
      { origin: target.origin, localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
    ],
    unsupported: [],
  };
}

const ADAPTERS = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookies",
  "cacheStorage",
  "tabs",
] as const;

function completeHeader(
  started: IdentityCapture,
  all: OthersRead,
  laid: LayoutRead,
  jar: Jar,
): IdentityCapture {
  const { reads } = all;
  return {
    ...started,
    status: "complete",
    endedAt: Date.now(),
    adapters: ADAPTERS.map((adapter) => ({ adapter, status: "captured" as const })),
    valueTypes: [...new Set(reads.flatMap(({ collected }) => collected.valueTypes))],
    cookies: jar,
    unsupported: [
      ...reads.flatMap(({ collected }) => collected.unsupported),
      ...all.unsupported,
      ...laid.unsupported,
    ],
    origins: reads.map(({ origin }) => origin),
    layout: laid.layout,
  };
}

/** Every cookie of the tab's store, checked against the names each origin's page showed. */
function cookieJar(deps: CaptureDeps, target: Target, reads: OriginRead[]) {
  const seen = reads.map(({ origin, page }) => ({
    host: new URL(origin.origin).hostname,
    names: page.cookieNames,
  }));
  return captureCookies(deps.cookies, target.storeId, new URL(target.origin).hostname, seen);
}

/** The target's page first, then every other origin the window visited, each in the helper tab. */
async function readOrigins(
  primary: PrimaryAccess,
  reading: { operation: BarrierOperation; captureId: string; windowId: number; identityId: string },
  target: Target,
  deps: CaptureDeps,
): Promise<OthersRead> {
  const first = await primary.read(originReader(reading, target.origin, deps));
  const visited = await deps.origins.visits.visited(reading.operation.generation);
  const others = visited.filter(({ origin }) => origin !== target.origin);
  const helper = { ...deps, helper: deps.origins.helper };
  const rest = await readOthers(others, reading, helper);
  return { ...rest, reads: [first, ...rest.reads] };
}

const COUNTED = [
  "localStorage",
  "sessionStorage",
  "databases",
  "records",
  "caches",
  "cacheEntries",
] as const;

function totals(reads: OriginRead[], laid: LayoutRead): CapturedCounts {
  const sum = (key: (typeof COUNTED)[number]) =>
    reads.reduce((total, { page }) => total + page.counts[key], 0);
  const counts = Object.fromEntries(COUNTED.map((key) => [key, sum(key)])) as CapturedCounts;
  return { ...counts, sessionStorage: counts.sessionStorage + laid.entries };
}

/** A published capture's counts and approximate size, never its values. */
function summaryOf(all: OthersRead, laid: LayoutRead, jar: Jar, header: IdentityCapture) {
  const { reads } = all;
  const kept = [
    ...reads.flatMap(({ origin }) => [origin.localStorage, origin.sessionStorage]),
    jar,
    laid.layout,
  ];
  const written = reads.reduce((total, { collected }) => total + collected.bytes, 0);
  return {
    ...totals(reads, laid),
    cookies: jar.length,
    unsupported: header.unsupported.length,
    skipped: all.skipped,
    bytes: written + approximateBytes(kept),
  };
}

interface Link {
  primary: PrimaryAccess;
  operation: BarrierOperation;
  windowId: number;
  found: SessionTabs;
  /** Where reading each tab's other origins notes the tabs it moved. */
  moved: MovedTab[];
}

/** Each tab's sessionStorage on the other origins it visited, read in that tab. */
async function readTabsOrigins(
  link: Link,
  laid: LayoutRead,
  identityId: string,
  deps: CaptureDeps,
) {
  let previous: Promise<IdentityCapture | null> | undefined;
  const run = {
    operation: link.operation,
    boundMs: boundOf(deps),
    live: deps.closing === true,
    moved: link.moved,
    previous: async () => (await (previous ??= deps.captures.read(identityId)))?.layout,
  };
  const { visits, helper } = deps.origins;
  const reading = { api: deps.api, barrier: helper.barrier, navigation: helper.navigation, visits };
  await readTabOrigins(link.found, laid, run, reading);
}

/**
 * Reads every origin, every other tab's sessionStorage, and the cookies, then publishes them as
 * `identityId`'s capture, or discards it.
 */
async function captureThrough(
  link: Link,
  target: Target,
  started: IdentityCapture,
  deps: CaptureDeps,
) {
  const { primary, found, operation, windowId } = link;
  const { captures } = deps;
  try {
    await captures.begin(started);
    const identityId = started.identityId;
    const reading = { operation, windowId, captureId: started.id, identityId };
    const all = await readOrigins(primary, reading, target, deps);
    const laid = await readLayout(found, { api: deps.api, operation, boundMs: boundOf(deps) });
    await readTabsOrigins(link, laid, identityId, deps);
    const jar = await cookieJar(deps, target, all.reads);
    const header = completeHeader(started, all, laid, jar);
    await captures.publish(header);
    return { ...summaryOf(all, laid, jar, header), tabs: found.seen };
  } catch (error) {
    await captures.discard(started.id).catch(() => undefined);
    throw error;
  }
}

const boundOf = (deps: CaptureDeps) => deps.boundMs ?? CAPTURE_BOUND_MS;
const since = (began: number) => Math.round(performance.now() - began);

/** The session's tabs, the window that had the focus last marked focused when none has it now. */
async function sessionTabsOf(deps: CaptureDeps, managed: ManagedWindowState) {
  const lastFocused = await deps.origins.visits.focusedWindow(managed.generation);
  return findSessionTabs(deps.api, managed.tabId, lastFocused);
}

/**
 * Captures the session's primary tab in full, every other origin it visited, every other tab's
 * sessionStorage and place, and the cookies as `identityId`'s saved data; `operationId` names the
 * helper tab's barriers, so a restart's recovery removes them.
 */
export async function captureIdentity(
  identityId: string,
  managed: ManagedWindowState,
  deps: CaptureDeps,
  operationId: string = crypto.randomUUID(),
): Promise<CaptureSummary> {
  const began = performance.now();
  const found = await sessionTabsOf(deps, managed);
  const target = await targetOf(deps, found.primary);
  const operation = { id: operationId, generation: managed.generation };
  const moved: MovedTab[] = [];
  const primary = await openPrimary(
    found.primary,
    { operation, boundMs: boundOf(deps), moved },
    { api: deps.api, ...deps.origins },
  );
  const started = startedHeader(identityId, target);
  let away = false;
  try {
    const link = { primary, operation, windowId: found.primary.windowId, found, moved };
    const counts = await captureThrough(link, target, started, deps);
    away = deps.closing === true;
    return { captureId: started.id, ...counts, ms: since(began), away: away ? moved : [] };
  } finally {
    primary.release();
    // Brought back unless the windows close next: reloading a page could rotate what was saved.
    if (!away) await returnTabs(deps.api, moved);
  }
}

/** Where a capture finds the visited origins and the helper tab: the bootstrap's own ports. */
export function captureOrigins(
  ports: Pick<BootstrapPorts, "visits" | "helperTabs" | "barrier" | "navigation">,
): CaptureDeps["origins"] {
  const { visits, helperTabs: tabs, barrier, navigation } = ports;
  return { visits, helper: { tabs, barrier, navigation } };
}
