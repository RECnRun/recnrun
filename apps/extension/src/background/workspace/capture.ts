import { approximateBytes } from "@recnrun/domain";
import type { IdentityCapture, ManagedWindowState, SkippedOrigin } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { isExpectedAgent } from "@/background/workspace/agent-link";
import { AGENT_SCRIPT } from "@/background/workspace/barrier";
import type { BarrierOperation } from "@/background/workspace/barrier";
import type { BootstrapPorts } from "@/background/workspace/bootstrap";
import { captureCookies } from "@/background/workspace/cookie-capture";
import { resolveTabStore } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";
import type { HelperDeps } from "@/background/workspace/helper-tab";
import { CAPTURE_BOUND_MS, readOrigin, readOthers } from "@/background/workspace/origin-reads";
import type { OriginRead, OthersRead } from "@/background/workspace/origin-reads";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { CapturedCounts, OriginPort } from "@/messaging/origin-protocol";
import type { VisitedOrigins } from "@/ports/visited-origins";
import type { IdentityCaptures } from "@/storage/identity-captures";

interface ConnectEvent {
  addListener: (listener: (port: OriginPort) => void) => void;
  removeListener: (listener: (port: OriginPort) => void) => void;
}

/** What a capture needs from Chrome: the tab's top document, the agent's injection, its port. */
export interface CaptureApi {
  topFrame: (tabId: number) => Promise<{ url: string; documentId: string } | null>;
  inject: (tabId: number, documentId: string) => Promise<void>;
  onConnect: ConnectEvent;
}

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

async function targetOf(deps: CaptureDeps, tabId: number): Promise<Target> {
  const frame = await deps.api.topFrame(tabId);
  const url = frame ? URL.parse(frame.url) : null;
  if (!frame || (url?.protocol !== "http:" && url?.protocol !== "https:")) {
    throw new WorkspaceError("TargetNotAllowed", "Only http and https pages can be captured.");
  }
  const storeId = await resolveTabStore(deps.cookies, tabId);
  return { tabId, documentId: frame.documentId, origin: url.origin, url: frame.url, storeId };
}

/** Injects the agent into the target document only and waits for its link; nothing stays registered. */
function connectAgent(api: CaptureApi, target: Target, boundMs: number): Promise<OriginPort> {
  return new Promise((resolve, reject) => {
    const end = (finish: () => void) => {
      clearTimeout(timer);
      api.onConnect.removeListener(onConnect);
      finish();
    };
    const fail = () =>
      end(() =>
        reject(new WorkspaceError("AgentNotConnected", "The page did not open its link in time.")),
      );
    const onConnect = (port: OriginPort) => {
      if (port.name !== ORIGIN_AGENT_PORT) return;
      if (isExpectedAgent(port, target)) end(() => resolve(port));
      else port.disconnect();
    };
    const timer = setTimeout(fail, boundMs);
    api.onConnect.addListener(onConnect);
    api.inject(target.tabId, target.documentId).catch(fail);
  });
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
] as const;

function completeHeader(started: IdentityCapture, all: OthersRead, jar: Jar): IdentityCapture {
  const { reads } = all;
  return {
    ...started,
    status: "complete",
    endedAt: Date.now(),
    adapters: ADAPTERS.map((adapter) => ({ adapter, status: "captured" as const })),
    valueTypes: [...new Set(reads.flatMap(({ collected }) => collected.valueTypes))],
    cookies: jar,
    unsupported: [...reads.flatMap(({ collected }) => collected.unsupported), ...all.unsupported],
    origins: reads.map(({ origin }) => origin),
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

function totals(reads: OriginRead[]): CapturedCounts {
  const sum = (key: (typeof COUNTED)[number]) =>
    reads.reduce((total, { page }) => total + page.counts[key], 0);
  return Object.fromEntries(COUNTED.map((key) => [key, sum(key)])) as CapturedCounts;
}

/** Reads every origin and the cookies, then publishes them as `identityId`'s capture, or discards it. */
async function captureThrough(
  { port, ...reading }: { port: OriginPort; operation: BarrierOperation; windowId: number },
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
    const { reads } = all;
    const jar = await cookieJar(deps, target, reads);
    const header = completeHeader(started, all, jar);
    await captures.publish(header);
    const kept = [
      ...reads.flatMap(({ origin }) => [origin.localStorage, origin.sessionStorage]),
      jar,
    ];
    const written = reads.reduce((total, { collected }) => total + collected.bytes, 0);
    return {
      ...totals(reads),
      cookies: jar.length,
      unsupported: header.unsupported.length,
      skipped: all.skipped,
      bytes: written + approximateBytes(kept),
    };
  } catch (error) {
    await captures.discard(started.id).catch(() => undefined);
    throw error;
  }
}

/**
 * Captures the managed tab's top document, every other origin the window visited, and the cookies
 * as `identityId`'s saved data; `operationId` names the helper tab's barriers, so a restart's
 * recovery removes them.
 */
export async function captureIdentity(
  identityId: string,
  managed: ManagedWindowState,
  deps: CaptureDeps,
  operationId: string = crypto.randomUUID(),
): Promise<CaptureSummary> {
  const began = performance.now();
  const target = await targetOf(deps, managed.tabId);
  const port = await connectAgent(deps.api, target, deps.boundMs ?? CAPTURE_BOUND_MS);
  const started = startedHeader(identityId, target);
  const operation = { id: operationId, generation: managed.generation };
  try {
    const link = { port, operation, windowId: managed.windowId };
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

/** Chrome's APIs; the getter reaches `runtime.onConnect` only when a capture runs. */
export const chromeCaptureApi: CaptureApi = {
  topFrame: async (tabId) => {
    const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
    return frame ? { url: frame.url, documentId: frame.documentId } : null;
  },
  inject: async (tabId, documentId) => {
    await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      files: [`/${AGENT_SCRIPT}` as const],
    });
  },
  get onConnect() {
    return browser.runtime.onConnect;
  },
};
