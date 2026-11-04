import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { namespaceFolder } from "./e4-launcher.ts";
import type { PresenceFile } from "./e4-launcher.ts";
import { identitySigner } from "./identity-statement.ts";
import type { IdentityStatement, Signer } from "./identity-statement.ts";

/*
 * E5's virtual peer: a profile the test plays by writing its files into the shared Downloads
 * folder, with the SDP and certificate of a real RTCPeerConnection, so the real profiles judge
 * its presence and signals by their own rules. Each mutation of a negative control is one of its
 * writes into the throwaway Downloads folder, never a change to RECnRun.
 */

const PREFIX = "RECNRUN-PAIR-1.";
// PAIRING_TTL_MS of apps/extension/src/p2p/pairing-code.ts and PRESENCE_TTL_MS of folder-rendezvous.ts.
export const PAIRING_TTL_MS = 5 * 60_000;
export const PRESENCE_TTL_MS = 60_000;
const REFRESH_MS = 20_000;

/** The lowest and highest lowercase v4 ids: the virtual peer offers to every profile, or answers it. */
export const LOWEST_ID = "00000000-0000-4000-8000-000000000000";
export const HIGHEST_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

/** The extension's StampedSignalSchema restated. */
const StampedSignalSchema = v.strictObject({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.pipe(v.string(), v.uuid()),
  profileId: v.pipe(v.string(), v.uuid()),
  to: v.pipe(v.string(), v.uuid()),
  expiresAt: v.number(),
  code: v.string(),
  boot: v.pipe(v.string(), v.uuid()),
  sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type StampedSignal = v.InferOutput<typeof StampedSignalSchema>;
type Kind = StampedSignal["kind"];

const PairingSchema = v.object({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.string(),
  profileId: v.string(),
  expiresAt: v.number(),
  sdp: v.string(),
  identity: v.object({ key: v.string(), signedAt: v.number(), signature: v.string() }),
});

export const signalFile = (downloads: string, from: string, kind: Kind, to: string) =>
  join(namespaceFolder(downloads), "peers", from, `${kind}-${to}.json`);

/** The pairing a code carries, as decodePairing reads it, without its checks. */
export const decodeCode = (code: string) =>
  v.parse(
    PairingSchema,
    JSON.parse(Buffer.from(code.slice(PREFIX.length), "base64url").toString("utf8")),
  );

/** The signal at `path`, or undefined while it is absent or not a stamped signal. */
export async function readSignal(path: string): Promise<StampedSignal | undefined> {
  try {
    const parsed = v.safeParse(StampedSignalSchema, JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces `path` by a rename, so no reader sees half of the text. */
async function replaceFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

interface PageGlobal {
  __virtual?: { certificate: RTCCertificate; held: RTCPeerConnection[]; states: string[] };
}

/**
 * A complete SDP from an RTCPeerConnection on the page's one certificate: an offer, or an answer
 * to `remote`. A held one stays open, so a profile can attempt a handshake with it, and notes its states.
 */
function gatheredSdp(page: Page, remote?: string, hold = false): Promise<string> {
  return page.evaluate(
    async ({ offer, keep }) => {
      const held = globalThis as unknown as PageGlobal;
      held.__virtual ??= {
        certificate: await RTCPeerConnection.generateCertificate({
          name: "ECDSA",
          namedCurve: "P-256",
        } as EcKeyGenParams),
        held: [],
        states: [],
      };
      const own = held.__virtual;
      const pc = new RTCPeerConnection({ certificates: [own.certificate] });
      if (keep) {
        own.held.push(pc);
        pc.oniceconnectionstatechange = () => own.states.push(`ice:${pc.iceConnectionState}`);
        pc.onconnectionstatechange = () => own.states.push(`peer:${pc.connectionState}`);
      }
      const complete = new Promise<void>((resolve) => {
        pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve();
      });
      if (offer === undefined) {
        pc.createDataChannel("recnrun-peer");
        await pc.setLocalDescription(await pc.createOffer());
      } else {
        await pc.setRemoteDescription({ type: "offer", sdp: offer });
        await pc.setLocalDescription(await pc.createAnswer());
      }
      await complete;
      const sdp = pc.localDescription?.sdp ?? "";
      // Closed unless held, so no real profile links to it: the test reads files, not a connection.
      if (!keep) pc.close();
      return sdp;
    },
    { offer: remote, keep: hold },
  );
}

const fingerprintOf = (sdp: string) =>
  /^a=fingerprint:sha-256 ([0-9A-F:]+)\s*$/im.exec(sdp)?.[1]?.toUpperCase() ?? "";

/** `sdp` naming `fingerprint` instead of the certificate its connection holds. */
const naming = (sdp: string, fingerprint: string) =>
  sdp.replaceAll(/^a=fingerprint:sha-256 [0-9A-F:]+/gim, `a=fingerprint:sha-256 ${fingerprint}`);

interface SignalOptions {
  boot?: string;
  pairingId?: string;
  sequence?: number;
  /** The file's and the code's expiry; PAIRING_TTL_MS from now by default. */
  expiresAt?: number;
  /** The offer an answer answers: its SDP and pairing id. */
  answering?: StampedSignal;
  /** Another profile's certificate and statement, which the SDP and the code name in place of its own. */
  claim?: { fingerprint: string; identity: IdentityStatement };
  /** Keeps the connection behind the SDP open, so a profile that accepts the code attempts a handshake. */
  hold?: boolean;
}

/** The SDP and statement a code carries: its own, or a claimed certificate's in their place. */
const claimed = (sdp: string, own: IdentityStatement, claim?: SignalOptions["claim"]) =>
  claim
    ? { sdp: naming(sdp, claim.fingerprint), identity: claim.identity }
    : { sdp, identity: own };

export interface VirtualPeer {
  profileId: string;
  displayName: string;
  fingerprint: string;
  /** Its own identity key's statement for its certificate, carried by its presence and codes. */
  identity: IdentityStatement;
  /** The boot of its current run, which its presence and, by default, its signals carry. */
  boot: string;
  /** Its presence now in the extension's key order, `changes` applied, without writing it. */
  presence(changes?: Partial<PresenceFile>): PresenceFile;
  /** Writes `presence(changes)` in the extension's exact bytes and keeps rewriting it until `stop`. */
  announce(changes?: Partial<PresenceFile>): Promise<PresenceFile>;
  /** A signal of `kind` for `to`, with a complete SDP of its certificate. */
  signal(kind: Kind, to: string, options?: SignalOptions): Promise<StampedSignal>;
  /** Writes text, a signal or not, at its signal file for `to`. */
  write(kind: Kind, to: string, text: string): Promise<void>;
  /** Replaces its presence by `text` and stops refreshing it. */
  writePresence(text: string): Promise<void>;
  /** The ICE and connection states its held connections went through, in order. */
  linkStates(): Promise<string[]>;
  stop(): void;
}

/**
 * A virtual peer `profileId` whose certificate lives in `page`, writing under `downloads`. It signs
 * with a key of its own unless `sign` is given, so claiming a real profile's id gives no pinned key.
 */
export async function virtualPeer(
  page: Page,
  downloads: string,
  profileId = LOWEST_ID,
  sign?: Signer,
): Promise<VirtualPeer> {
  const fingerprint = fingerprintOf(await gatheredSdp(page));
  const identity = await (sign ?? (await identitySigner()))(profileId, fingerprint);
  const displayName = `Virtual ${profileId.slice(0, 4).toUpperCase()}`;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  // Read through a function, so a check after an await is not narrowed to the value before it.
  const live = () => !stopped;
  let sequence = 0;
  const presencePath = join(namespaceFolder(downloads), "peers", profileId, "presence.json");
  const presence = (changes: Partial<PresenceFile> = {}): PresenceFile => {
    const now = Date.now();
    const fresh = { createdAt: now, expiresAt: now + PRESENCE_TTL_MS };
    // Spread in place, so `changes` keep the extension's key order.
    const base = {
      profileId,
      displayName,
      fingerprint,
      identity,
      ...fresh,
      namespace: "lab" as const,
    };
    return { ...base, boot: current.boot, ...changes };
  };
  const announce = async (changes: Partial<PresenceFile> = {}) => {
    const written = presence(changes);
    if (!live()) return written;
    await replaceFile(presencePath, JSON.stringify(written));
    clearInterval(timer);
    // A refresh outliving its sample would rewrite the next sample's folder with a stale boot.
    if (live())
      timer = setInterval(() => void announce(changes).catch(() => undefined), REFRESH_MS);
    return written;
  };
  const write = (kind: Kind, to: string, text: string) =>
    replaceFile(signalFile(downloads, profileId, kind, to), text);
  const signal = async (kind: Kind, to: string, options: SignalOptions = {}) => {
    const pairingId = options.pairingId ?? options.answering?.pairingId ?? randomUUID();
    const expiresAt = options.expiresAt ?? Date.now() + PAIRING_TTL_MS;
    const remote = options.answering && decodeCode(options.answering.code).sdp;
    const carried = claimed(await gatheredSdp(page, remote, options.hold), identity, options.claim);
    const pairing = { kind, pairingId, profileId, displayName, expiresAt, ...carried };
    const code = PREFIX + Buffer.from(JSON.stringify(pairing)).toString("base64url");
    sequence = Math.max(sequence + 1, Date.now());
    const boot = options.boot ?? current.boot;
    return {
      kind,
      pairingId,
      profileId,
      to,
      expiresAt,
      code,
      boot,
      sequence: options.sequence ?? sequence,
    };
  };
  const current: VirtualPeer = {
    profileId,
    displayName,
    fingerprint,
    identity,
    boot: randomUUID(),
    presence,
    announce,
    signal,
    write,
    writePresence: async (text) => {
      clearInterval(timer);
      await replaceFile(presencePath, text);
    },
    linkStates: () =>
      page.evaluate(() => [...((globalThis as unknown as PageGlobal).__virtual?.states ?? [])]),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
  return current;
}
