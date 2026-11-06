import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { IdentityKeySchema, SIGNED } from "@/p2p/identity-key";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";

/** How a pin was first made: the code pasted or exchanged, the local channel, or a user's approval. */
const PinSourceSchema = v.picklist(["pairing-code", "local-channel", "manual"]);

/**
 * A peer's identity key as this profile first verified it, never replaced, with the last DTLS
 * certificate a link proved and the key signed: a renewed certificate moves only `fingerprint`.
 */
export const PinSchema = v.strictObject({
  fingerprint: FingerprintSchema,
  pinnedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  source: PinSourceSchema,
  // Production keeps no pins; the cast types the entry its bundle folds away.
  ...(SIGNED ? { identity: IdentityKeySchema } : ({} as { identity: typeof IdentityKeySchema })),
});

const PinRequestSchema = v.strictObject({
  profileId: ProfileIdSchema,
  identity: IdentityKeySchema,
  fingerprint: FingerprintSchema,
  source: PinSourceSchema,
});

export type Pin = v.InferOutput<typeof PinSchema>;
export type PinSource = Pin["source"];
/**
 * Unpinned is a first meeting; a mismatch is a pinned profile whose certificate no valid signature
 * by the pinned identity names: unsigned, or signed by another key.
 */
export type PinVerdict = "pinned-match" | "pinned-mismatch" | "unpinned";
/** What a link proved: the certificate, and the identity key whose statement names it. */
export interface Proven {
  identity: string;
  fingerprint: string;
}
export type PinOutcome =
  | { ok: true; pin: Pin }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "pinned-different"; pinned: Pin }
  | { ok: false; reason: "store-failed"; error: string };

/** Where the pins live, keyed by profile id; the storage boundary validates them. */
export interface PinRecords {
  get: (profileId: string) => Promise<Pin | null>;
  set: (profileId: string, pin: Pin) => Promise<unknown>;
}

async function pinOnce(
  store: PinRecords,
  request: v.InferOutput<typeof PinRequestSchema>,
  now: number,
) {
  const { profileId, identity, fingerprint, source } = request;
  const pinned = await store.get(profileId);
  if (pinned && pinned.identity !== identity)
    return { ok: false, reason: "pinned-different", pinned } as const;
  if (pinned?.fingerprint === fingerprint) return { ok: true, pin: pinned } as const;
  // The pinned identity's renewed certificate: the pin stays, and its last fingerprint follows.
  const pin: Pin = pinned
    ? { ...pinned, fingerprint }
    : { fingerprint, pinnedAt: now, source, identity };
  await store.set(profileId, pin);
  return { ok: true, pin } as const;
}

/**
 * Each peer's identity key pinned at the first verified meeting. A catalog, presence, or code whose
 * certificate the pinned key did not sign is a mismatch; nothing here replaces a pinned key.
 */
export function createPins(store: PinRecords, now: () => number = Date.now) {
  let queue: Promise<unknown> = Promise.resolve();
  // Each pin reads before it writes, so two at once would otherwise both see the profile unpinned.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const pinOf = (profileId: string) => serial(() => store.get(profileId));
  /** `signer` is the key whose valid signature names the certificate seen, undefined if none does. */
  const verify = async (profileId: string, signer: string | undefined): Promise<PinVerdict> => {
    const pinned = await pinOf(profileId);
    if (!pinned) return "unpinned";
    return pinned.identity === signer ? "pinned-match" : "pinned-mismatch";
  };
  /** Pins the identity of a first meeting, or notes the pinned identity's latest certificate. */
  const pin = (profileId: string, proven: Proven, source: PinSource): Promise<PinOutcome> => {
    const request = v.safeParse(PinRequestSchema, { profileId, ...proven, source });
    if (!request.success) return Promise.resolve({ ok: false, reason: "malformed" });
    return serial(() => pinOnce(store, request.output, now())).catch((error: unknown) => ({
      ok: false as const,
      reason: "store-failed" as const,
      error: errorMessage(error),
    }));
  };
  return { pinOf, pin, verify };
}

export type Pins = ReturnType<typeof createPins>;
