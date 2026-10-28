import type { CaptureCapabilities, IdentityCapture, ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { captureThroughAgent, isExpectedAgent } from "@/background/workspace/agent-link";
import { AGENT_SCRIPT } from "@/background/workspace/barrier";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { checkWhole, collector } from "@/background/workspace/capture-collector";
import type { Collected, WebStorage } from "@/background/workspace/capture-collector";
import { captureCookies } from "@/background/workspace/cookie-capture";
import { resolveTabStore } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";
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
  caches: number;
  cacheEntries: number;
  cookies: number;
  unsupported: number;
  ms: number;
}

/** How long the agent may take to connect, and to send its next message. */
const CAPTURE_BOUND_MS = 15_000;

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

const ADAPTERS = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookies",
  "cacheStorage",
] as const;

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
    adapters: ADAPTERS.map((adapter) => ({ adapter, status: "captured" as const })),
    valueTypes: collected.valueTypes,
    cookies: jar.cookies,
    unsupported: [...jar.unsupported, ...collected.unsupported],
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
    const header = completeHeader(started, storage, collected, jar);
    await captures.publish(header);
    return { ...counts, cookies: jar.cookies.length, unsupported: header.unsupported.length };
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
