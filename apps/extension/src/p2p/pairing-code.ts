import * as v from "valibot";
import { ProfileIdSchema } from "@/p2p/protocol";

const PREFIX = "RECNRUN-PAIR-1.";
/** An offer older than this is refused, so a code left in a folder or a chat cannot be replayed. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

export const PairingSchema = v.strictObject({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.pipe(v.string(), v.uuid()),
  profileId: ProfileIdSchema,
  displayName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(64)),
  expiresAt: v.pipe(v.number(), v.integer()),
  sdp: v.pipe(v.string(), v.nonEmpty(), v.maxLength(64 * 1024)),
});

/** One side's half of a pairing: who it is, until when it holds, and its full SDP. */
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

/** One line of text, safe to paste anywhere: no whitespace for chat apps to mangle. */
export const encodePairing = (pairing: Pairing) => PREFIX + toBase64Url(JSON.stringify(pairing));

/** Decodes and validates a pasted code; throws with a reason the pairing page shows. */
export function decodePairing(code: string, now = Date.now()): Pairing {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error("This is not a RECnRun pairing code.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error("The pairing code is damaged; copy it again.");
  }
  const result = v.safeParse(PairingSchema, parsed);
  if (!result.success) throw new Error("The pairing code is damaged; copy it again.");
  if (result.output.expiresAt <= now)
    throw new Error("The pairing code expired; create a new one.");
  return result.output;
}

/** The DTLS certificate fingerprint an SDP announces, which the handshake then proves. */
export function fingerprintOf(sdp: string): string | undefined {
  return /^a=fingerprint:sha-256 ([0-9A-F:]+)\s*$/im.exec(sdp)?.[1]?.toUpperCase();
}

/**
 * Six digits both sides show, derived from both certificate fingerprints in either order. Equal
 * digits on both screens mean no one in between swapped a certificate.
 */
export async function shortAuthenticationString(mine: string, theirs: string): Promise<string> {
  const joined = [mine, theirs].toSorted().join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  const value = new DataView(digest).getUint32(0) % 1_000_000;
  return String(value).padStart(6, "0");
}
