import type {
  AdapterEvent,
  BrowserHandshake,
  CdpTarget,
  ConnectionSource,
  DiscoveryResult,
  ProfileDescription,
} from "@recnrun/protocol";
import type { CdpLink, CdpTransport } from "./cdp-link.ts";
import { discover, type DiscoverOptions } from "./discovery.ts";
import { parseTargets, readHandshake } from "./handshake.ts";
import { playwrightTransport } from "./playwright-transport.ts";
import { describeProfile } from "./profile.ts";

export type ReconnectOutcome =
  | { ok: true; connection: CdpConnection }
  | { ok: false; code: "endpoint-gone"; remedy: string };

export interface ConnectOptions {
  onEvent?: (event: AdapterEvent) => void;
  /** The DevToolsActivePort that `reconnect()` reads again. */
  source?: ConnectionSource;
  transport?: CdpTransport;
  discover?: (options: DiscoverOptions) => Promise<DiscoveryResult>;
  now?: () => Date;
}

export interface CdpConnection {
  readonly endpoint: string;
  readonly handshake: BrowserHandshake;
  listTargets(): Promise<CdpTarget[]>;
  disconnect(): Promise<void>;
  reconnect(source?: ConnectionSource): Promise<ReconnectOutcome>;
  describeProfile(): Promise<ProfileDescription>;
}

type EventBody = AdapterEvent extends infer E
  ? E extends AdapterEvent
    ? Omit<E, "seq" | "at" | "endpoint">
    : never
  : never;

/** Builds an event body from the time the event is stamped with. */
type Emit = (build: (at: string) => EventBody) => void;

/** The producer sequence of the adapter's events; it survives reconnections. */
interface Sequence {
  last: number;
}

const gone = (remedy: string): ReconnectOutcome => ({ ok: false, code: "endpoint-gone", remedy });

function contestedTargets(reply: unknown): CdpTarget[] {
  // Before our own client attaches, `attached` can only mean someone else's debugger.
  return parseTargets(reply).filter((target) => target.type === "page" && target.attached);
}

async function openLink(transport: CdpTransport, endpoint: string) {
  const contested = contestedTargets(await transport.preflightTargets(endpoint));
  const link = await transport.open(endpoint);
  try {
    return { link, contested, handshake: await readHandshake(link, endpoint) };
  } catch (error) {
    await link.close();
    throw error;
  }
}

function watchLoss(link: CdpLink, emit: Emit, sequence: Sequence) {
  const state = { closing: false, lost: false };
  link.onDisconnected(() => {
    if (state.closing || state.lost) return;
    state.lost = true;
    const lastSeq = sequence.last;
    emit((startedAt) => ({
      type: "connection.lost",
      gap: { reason: "connection-lost", startedAt, ...(lastSeq > 0 && { lastSeq }) },
    }));
  });
  return state;
}

async function reconnectThrough(
  options: ConnectOptions,
  source: ConnectionSource | undefined,
  sequence: Sequence,
): Promise<ReconnectOutcome> {
  if (!source) {
    return gone(
      "This connection has no DevToolsActivePort to return to; connect with a userDataDir or activePortFile.",
    );
  }
  const found = await (options.discover ?? discover)(source);
  if (!found.ok) return gone(found.remedy);
  try {
    return { ok: true, connection: await open(found.wsEndpoint, { ...options, source }, sequence) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return gone(`${found.wsEndpoint} did not answer: ${reason}`);
  }
}

async function open(
  endpoint: string,
  options: ConnectOptions,
  sequence: Sequence,
): Promise<CdpConnection> {
  const now = options.now ?? (() => new Date());
  const { link, contested, handshake } = await openLink(
    options.transport ?? playwrightTransport,
    endpoint,
  );
  const emit: Emit = (build) => {
    const at = now().toISOString();
    sequence.last += 1;
    options.onEvent?.({ ...build(at), seq: sequence.last, at, endpoint });
  };
  const state = watchLoss(link, emit, sequence);
  for (const { targetId, url } of contested) {
    emit(() => ({ type: "control.contested", targetId, url, signal: "attached-before-connect" }));
  }
  const disconnect = async () => {
    state.closing = true;
    await link.close();
  };
  return {
    endpoint,
    handshake,
    listTargets: async () => parseTargets(await link.send("Target.getTargets")),
    disconnect,
    reconnect: async (source = options.source) => {
      if (!state.lost) await disconnect();
      return reconnectThrough(options, source, sequence);
    },
    describeProfile: () => describeProfile(link, handshake, options.source),
  };
}

/** Connects Playwright and a browser-level CDP session to the Chrome at `endpoint`. */
export function connect(endpoint: string, options: ConnectOptions = {}): Promise<CdpConnection> {
  return open(endpoint, options, { last: 0 });
}
