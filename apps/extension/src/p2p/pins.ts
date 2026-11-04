import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";

/** How a pin was first made: the code pasted or exchanged, the local channel, or a user's approval. */
const PinSourceSchema = v.picklist(["pairing-code", "local-channel", "manual"]);

/** A peer's DTLS certificate fingerprint as this profile first verified it; never replaced. */
export const PinSchema = v.strictObject({
  fingerprint: FingerprintSchema,
  pinnedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  source: PinSourceSchema,
});

const PinRequestSchema = v.strictObject({
  profileId: ProfileIdSchema,
  fingerprint: FingerprintSchema,
  source: PinSourceSchema,
});

export type Pin = v.InferOutput<typeof PinSchema>;
export type PinSource = Pin["source"];
/** Unpinned is a first meeting; a mismatch is a pinned profile announcing another certificate. */
export type PinVerdict = "pinned-match" | "pinned-mismatch" | "unpinned";
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
  const { profileId, fingerprint, source } = request;
  const pinned = await store.get(profileId);
  if (pinned?.fingerprint === fingerprint) return { ok: true, pin: pinned } as const;
  if (pinned) return { ok: false, reason: "pinned-different", pinned } as const;
  const pin: Pin = { fingerprint, pinnedAt: now, source };
  await store.set(profileId, pin);
  return { ok: true, pin } as const;
}

/**
 * Each peer's certificate pinned at the first verified meeting. A catalog, presence, or code that
 * announces another certificate for a pinned profile is a mismatch; nothing here overwrites a pin.
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
  const verify = async (profileId: string, observed: string): Promise<PinVerdict> => {
    const pinned = await pinOf(profileId);
    if (!pinned) return "unpinned";
    return pinned.fingerprint === observed ? "pinned-match" : "pinned-mismatch";
  };
  const pin = (profileId: string, fingerprint: string, source: PinSource): Promise<PinOutcome> => {
    const request = v.safeParse(PinRequestSchema, { profileId, fingerprint, source });
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
