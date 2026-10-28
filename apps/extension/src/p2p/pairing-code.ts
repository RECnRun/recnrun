import * as v from "valibot";
import { ProfileIdSchema } from "@/p2p/protocol";

const PREFIX = "RECNRUN-PAIR-1.";
/** A code older than this is refused, so one left in a folder or a chat cannot be replayed. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
const DAMAGED = "The pairing code is damaged; copy it again.";

export const DisplayNameSchema = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(64));

const PairingSchema = v.strictObject({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.pipe(v.string(), v.uuid()),
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  expiresAt: v.pipe(v.number(), v.integer()),
  sdp: v.pipe(v.string(), v.nonEmpty(), v.maxLength(64 * 1024)),
});

/** One side's half of a pairing: who it is, until when it holds, and its complete SDP. */
export type Pairing = v.InferOutput<typeof PairingSchema>;

const toBase64Url = (text: string) =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

function fromBase64Url(code: string): string {
  const binary = atob(code.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
}

/** One line of text, safe to paste anywhere: no whitespace for a chat app to mangle. */
export const encodePairing = (pairing: Pairing) => PREFIX + toBase64Url(JSON.stringify(pairing));

/** Decodes and validates a code; throws with the reason it is refused. */
export function decodePairing(code: string, now = Date.now()): Pairing {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error("This is not a RECnRun pairing code.");
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error(DAMAGED);
  }
  const parsed = v.safeParse(PairingSchema, json);
  if (!parsed.success) throw new Error(DAMAGED);
  if (parsed.output.expiresAt <= now)
    throw new Error("The pairing code expired; create a new one.");
  return parsed.output;
}

/** The DTLS certificate fingerprint an SDP announces, which the handshake then proves. */
export function fingerprintOf(sdp: string): string | undefined {
  return /^a=fingerprint:sha-256 ([0-9A-F:]+)\s*$/im.exec(sdp)?.[1]?.toUpperCase();
}
