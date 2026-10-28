import type { IdentityCapture, ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { captureThroughAgent, isExpectedAgent } from "@/background/workspace/agent-link";
import type { CaptureReceiver } from "@/background/workspace/agent-link";
import { AGENT_SCRIPT } from "@/background/workspace/barrier";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { WorkspaceError } from "@/background/workspace/errors";
import { ownBlobs } from "@/background/workspace/own-blobs";
import { collectValueTypes } from "@/background/workspace/value-types";
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
  boundMs?: number;
}

/** A published capture's size and duration, never its values. */
export interface CaptureSummary {
  captureId: string;
  databases: number;
  records: number;
  ms: number;
}

/** How long the agent may take to connect, and to send its next message. */
const CAPTURE_BOUND_MS = 15_000;

type ValueType = IdentityCapture["valueTypes"][number];
type Database = IdentityCapture["origins"][number]["indexedDB"][number];

interface Target {
  tabId: number;
  documentId: string;
  origin: string;
  url: string;
}

async function targetOf(api: CaptureApi, tabId: number): Promise<Target> {
  const frame = await api.topFrame(tabId);
  const url = frame ? URL.parse(frame.url) : null;
  if (!frame || (url?.protocol !== "http:" && url?.protocol !== "https:")) {
    throw new WorkspaceError("TargetNotAllowed", "Only http and https pages can be captured.");
  }
  return { tabId, documentId: frame.documentId, origin: url.origin, url: frame.url };
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
    capabilities: { cookieHosts: [] },
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
  let records = 0;
  let writing = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const receiver: CaptureReceiver = {
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
  const written = async () => {
    await writing;
    if (failure) throw failure.error;
    return { databases, valueTypes: [...valueTypes], records };
  };
  return { receiver, written };
}

const SKIPPED = ["localStorage", "sessionStorage", "cookies", "cacheStorage"] as const;

function completeHeader(
  started: IdentityCapture,
  databases: Database[],
  valueTypes: ValueType[],
): IdentityCapture {
  const [origin] = started.origins;
  return {
    ...started,
    status: "complete",
    endedAt: Date.now(),
    adapters: [
      { adapter: "indexedDB", status: "captured" },
      ...SKIPPED.map((adapter) => ({ adapter, status: "skipped" as const })),
    ],
    valueTypes,
    origins: origin ? [{ ...origin, indexedDB: databases }] : [],
  };
}

/** Reads the page through its link and publishes it as `identityId`'s capture, or discards it. */
async function captureThrough(
  port: OriginPort,
  operation: BarrierOperation,
  started: IdentityCapture,
  deps: CaptureDeps,
) {
  const { captures, boundMs = CAPTURE_BOUND_MS } = deps;
  try {
    await captures.begin(started);
    const { receiver, written } = collector(started.id, started.origins[0]?.origin ?? "", captures);
    const counts = await captureThroughAgent(port, operation, receiver, boundMs);
    const { databases, valueTypes, records } = await written();
    if (databases.length !== counts.databases || records !== counts.records) {
      throw new WorkspaceError("CaptureIncomplete", "The page's data did not all arrive.");
    }
    await captures.publish(completeHeader(started, databases, valueTypes));
    return counts;
  } catch (error) {
    await captures.discard(started.id).catch(() => undefined);
    throw error;
  }
}

/** Captures the managed tab's top document as `identityId`'s saved data. */
export async function captureIdentity(
  identityId: string,
  managed: ManagedWindowState,
  deps: CaptureDeps,
): Promise<CaptureSummary> {
  const began = performance.now();
  const target = await targetOf(deps.api, managed.tabId);
  const port = await connectAgent(deps.api, target, deps.boundMs ?? CAPTURE_BOUND_MS);
  const started = startedHeader(identityId, target);
  const operation = { id: crypto.randomUUID(), generation: managed.generation };
  try {
    const counts = await captureThrough(port, operation, started, deps);
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
