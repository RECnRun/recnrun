import { approximateBytes } from "@recnrun/domain";
import type { IdentityCapture, ManagedWindowState, SkippedOrigin } from "@recnrun/domain";
import type { BarrierOperation } from "@/background/workspace/barrier";
import type { BootstrapPorts } from "@/background/workspace/bootstrap";
import { connectAgent } from "@/background/workspace/capture-api";
import type { CaptureApi } from "@/background/workspace/capture-api";
import { captureCookies } from "@/background/workspace/cookie-capture";
import { resolveTabStore } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import type { HelperDeps } from "@/background/workspace/helper-tab";
import { CAPTURE_BOUND_MS, readOrigin, readOthers } from "@/background/workspace/origin-reads";
import type { OriginRead, OthersRead } from "@/background/workspace/origin-reads";
import { findSessionTabs, readLayout } from "@/background/workspace/session-tabs";
import type { LayoutRead, SessionTab, SessionTabs } from "@/background/workspace/session-tabs";
import type { CapturedCounts, OriginPort } from "@/messaging/origin-protocol";
import type { VisitedOrigins } from "@/ports/visited-origins";
import type { IdentityCaptures } from "@/storage/identity-captures";

export interface CaptureDeps {
  api: CaptureApi;
  captures: Pick<
    IdentityCaptures,
    "begin" | "append" | "dropParts" | "publish" | "discard" | "read"
  >;
  cookies: Pick<CookieApi, "stores" | "normalTabIds" | "all">;
  /** The other origins the window visited, and the helper tab each one loads in. */
  origins: { visits: Pick<VisitedOrigins, "visited">; helper: HelperDeps };
  boundMs?: number;
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
}

interface Target {
  tabId: number;
  documentId: string;
  origin: string;
  url: string;
  /** The tab's Incognito cookie store. */
  storeId: string;
}

type Jar = IdentityCapture["cookies"];

async function targetOf(deps: CaptureDeps, tab: SessionTab): Promise<Target> {
  const { tabId, documentId, origin, url } = tab;
  const storeId = await resolveTabStore(deps.cookies, tabId);
  return { tabId, documentId, origin, url, storeId };
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
  port: OriginPort,
  reading: { operation: BarrierOperation; captureId: string; windowId: number; identityId: string },
  target: Target,
  deps: CaptureDeps,
): Promise<OthersRead> {
  const first = await readOrigin(port, reading, target.origin, deps);
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
  port: OriginPort;
  operation: BarrierOperation;
  windowId: number;
  found: SessionTabs;
}

/**
 * Reads every origin, every other tab's sessionStorage, and the cookies, then publishes them as
 * `identityId`'s capture, or discards it.
 */
async function captureThrough(
  { port, found, ...reading }: Link,
  target: Target,
  started: IdentityCapture,
  deps: CaptureDeps,
) {
  const { captures } = deps;
  try {
    await captures.begin(started);
    const identityId = started.identityId;
    const all = await readOrigins(
      port,
      { ...reading, captureId: started.id, identityId },
      target,
      deps,
    );
    const reader = { api: deps.api, operation: reading.operation, boundMs: boundOf(deps) };
    const laid = await readLayout(found, reader);
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

/**
 * Captures the session's primary tab in full, every other origin it visited, every other tab's
 * sessionStorage and place, and the cookies as `identityId`'s saved data; `operationId` names the helper tab's barriers, so a restart's
 * recovery removes them.
 */
export async function captureIdentity(
  identityId: string,
  managed: ManagedWindowState,
  deps: CaptureDeps,
  operationId: string = crypto.randomUUID(),
): Promise<CaptureSummary> {
  const began = performance.now();
  const found = await findSessionTabs(deps.api, managed.tabId);
  const target = await targetOf(deps, found.primary);
  const port = await connectAgent(deps.api, target, boundOf(deps));
  const started = startedHeader(identityId, target);
  const operation = { id: operationId, generation: managed.generation };
  try {
    const link = { port, operation, windowId: found.primary.windowId, found };
    const counts = await captureThrough(link, target, started, deps);
    return { captureId: started.id, ...counts, ms: Math.round(performance.now() - began) };
  } finally {
    port.disconnect();
  }
}

/** Where a capture finds the visited origins and the helper tab: the bootstrap's own ports. */
export function captureOrigins(
  ports: Pick<BootstrapPorts, "visits" | "helperTabs" | "barrier" | "navigation">,
): CaptureDeps["origins"] {
  const { visits, helperTabs: tabs, barrier, navigation } = ports;
  return { visits, helper: { tabs, barrier, navigation } };
}
