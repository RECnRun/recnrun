import type { CaptureCapabilities, IdentityCapture, ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { captureThroughAgent, isExpectedAgent } from "@/background/workspace/agent-link";
import type { CaptureReceiver } from "@/background/workspace/agent-link";
import { AGENT_SCRIPT } from "@/background/workspace/barrier";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { captureCookies } from "@/background/workspace/cookie-capture";
import { resolveTabStore } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";
import { ownBlobs } from "@/background/workspace/own-blobs";
import { collectValueTypes } from "@/background/workspace/value-types";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { CapturedCounts, OriginPort } from "@/messaging/origin-protocol";
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
  captures: Pick<IdentityCaptures, "begin" | "append" | "publish" | "discard">;
  cookies: Pick<CookieApi, "stores" | "normalTabIds" | "all">;
  boundMs?: number;
}

/** A published capture's size and duration, never its values. */
export interface CaptureSummary {
  captureId: string;
  localStorage: number;
  sessionStorage: number;
  databases: number;
  records: number;
  cookies: number;
  unsupported: number;
  ms: number;
}

/** How long the agent may take to connect, and to send its next message. */
const CAPTURE_BOUND_MS = 15_000;

type ValueType = IdentityCapture["valueTypes"][number];
type OriginCapture = IdentityCapture["origins"][number];
type Database = OriginCapture["indexedDB"][number];
type WebStorage = Pick<OriginCapture, "localStorage" | "sessionStorage">;

/** What the collector received, checked against the agent's counts before anything is published. */
interface Collected {
  storage?: WebStorage;
  databases: Database[];
  valueTypes: ValueType[];
  records: number;
}

interface Target {
  tabId: number;
  documentId: string;
  origin: string;
  url: string;
  /** The tab's Incognito cookie store. */
  storeId: string;
}

type Jar = Pick<IdentityCapture, "cookies" | "unsupported">;

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

function startedHeader(
  identityId: string,
  target: Target,
  capabilities: CaptureCapabilities,
): IdentityCapture {
  return {
    formatVersion: 1,
    id: crypto.randomUUID(),
    identityId,
    url: target.url,
    capabilities,
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

/** Writes each received part in order; after one write fails, it writes no later part. */
function collector(captureId: string, origin: string, captures: CaptureDeps["captures"]) {
  const databases: Database[] = [];
  const valueTypes = new Set<ValueType>();
  let storage: WebStorage | undefined;
  let records = 0;
  let writing = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const receiver: CaptureReceiver = {
    storage: ({ localStorage, sessionStorage }) => {
      storage = { localStorage, sessionStorage };
    },
    database: (database) => databases.push(database),
    records: ({ database, store, records: part }) => {
      records += part.length;
      collectValueTypes(
        part.flatMap(({ key, value }) => (key === undefined ? [value] : [key, value])),
        valueTypes,
      );
      writing = writing.then(async () => {
        if (failure) return;
        try {
          await ownBlobs(part);
          await captures.append(captureId, { origin, database, store, records: part });
        } catch (error) {
          failure = { error };
        }
      });
    },
  };
  const written = async (): Promise<Collected> => {
    await writing;
    if (failure) throw failure.error;
    return { storage, databases, valueTypes: [...valueTypes], records };
  };
  return { receiver, written };
}

const SKIPPED = ["cacheStorage"] as const;
const CAPTURED = ["localStorage", "sessionStorage", "indexedDB", "cookies"] as const;

/** Every count the agent sent must match what arrived, or the capture is not whole. */
function checkWhole(collected: Collected, counts: CapturedCounts): WebStorage {
  const { storage, databases, records } = collected;
  const whole =
    storage !== undefined &&
    Object.keys(storage.localStorage).length === counts.localStorage &&
    Object.keys(storage.sessionStorage).length === counts.sessionStorage &&
    databases.length === counts.databases &&
    records === counts.records;
  if (!whole) throw new WorkspaceError("CaptureIncomplete", "The page's data did not all arrive.");
  return storage;
}

function completeHeader(
  started: IdentityCapture,
  storage: WebStorage,
  collected: Collected,
  jar: Jar,
): IdentityCapture {
  const [origin] = started.origins;
  return {
    ...started,
    status: "complete",
    endedAt: Date.now(),
    adapters: [
      ...CAPTURED.map((adapter) => ({ adapter, status: "captured" as const })),
      ...SKIPPED.map((adapter) => ({ adapter, status: "skipped" as const })),
    ],
    valueTypes: collected.valueTypes,
    ...jar,
    origins: origin ? [{ ...origin, ...storage, indexedDB: collected.databases }] : [],
  };
}

/** The store's cookies of the target's host and the declared ones; a failed read fails the capture. */
async function cookieJar(deps: CaptureDeps, target: Target, started: IdentityCapture) {
  try {
    return await captureCookies(deps.cookies, target.storeId, {
      target: new URL(target.origin).hostname,
      extra: started.capabilities.cookieHosts,
    });
  } catch {
    throw new WorkspaceError("CookiesNotCaptured", "Chrome did not list the workspace's cookies.");
  }
}

/** Reads the page through its link and publishes it as `identityId`'s capture, or discards it. */
async function captureThrough(
  { port, operation }: { port: OriginPort; operation: BarrierOperation },
  target: Target,
  started: IdentityCapture,
  deps: CaptureDeps,
) {
  const { captures, boundMs = CAPTURE_BOUND_MS } = deps;
  try {
    await captures.begin(started);
    const { receiver, written } = collector(started.id, started.origins[0]?.origin ?? "", captures);
    const counts = await captureThroughAgent(port, operation, receiver, boundMs);
    const collected = await written();
    const storage = checkWhole(collected, counts);
    const jar = await cookieJar(deps, target, started);
    await captures.publish(completeHeader(started, storage, collected, jar));
    return { ...counts, cookies: jar.cookies.length, unsupported: jar.unsupported.length };
  } catch (error) {
    await captures.discard(started.id).catch(() => undefined);
    throw error;
  }
}

/** Captures the managed tab's top document and its cookies as `identityId`'s saved data. */
export async function captureIdentity(
  identityId: string,
  managed: ManagedWindowState,
  deps: CaptureDeps,
  capabilities: CaptureCapabilities = { cookieHosts: [] },
): Promise<CaptureSummary> {
  const began = performance.now();
  const target = await targetOf(deps, managed.tabId);
  const port = await connectAgent(deps.api, target, deps.boundMs ?? CAPTURE_BOUND_MS);
  const started = startedHeader(identityId, target, capabilities);
  const operation = { id: crypto.randomUUID(), generation: managed.generation };
  try {
    const counts = await captureThrough({ port, operation }, target, started, deps);
    return { captureId: started.id, ...counts, ms: Math.round(performance.now() - began) };
  } finally {
    port.disconnect();
  }
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
