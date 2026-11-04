import * as v from "valibot";
import { CLOCK_SKEW_MS, NamespaceSchema, readTolerantOf } from "@/p2p/downloads-rendezvous";
import type { Freshness, TolerantRead } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { DisplayNameSchema } from "@/p2p/pairing-code";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";

/*
 * The catalog of the Downloads rendezvous (POC PLAN.md decision 11): what an extension registers
 * for the launcher, and the registry.json the launcher alone writes back. Neither carries a path:
 * the launcher learns a Downloads root by finding a profile's file under it, and names each root
 * it knows with an opaque id.
 */

/** The catalog outlives two presence periods, so one missed launcher pass drops nobody. */
export const REGISTRY_TTL_MS = 2 * PRESENCE_TTL_MS;
export const MAX_REGISTRY_PEERS = 32;

const BootSchema = v.pipe(v.string(), v.uuid());
const TimeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/**
 * What an extension publishes for the launcher: its presence, its namespace, and the boot of its
 * process, which tells a registration of an earlier run apart. A strict object, so a `path`,
 * `root`, `userDataDir`, `directory`, or `filename` key is refused like any other. It lives at
 * most one presence TTL after it is stamped, the bound catalog.sh enforces.
 */
export const RegistrationSchema = v.pipe(
  v.strictObject({
    // PresenceSchema's entries spelled out: a spread of them would stay in the production background.
    profileId: ProfileIdSchema,
    displayName: DisplayNameSchema,
    fingerprint: FingerprintSchema,
    createdAt: v.number(),
    expiresAt: v.number(),
    namespace: NamespaceSchema,
    boot: BootSchema,
  }),
  v.check(
    ({ createdAt, expiresAt }) => expiresAt > createdAt && expiresAt - createdAt <= PRESENCE_TTL_MS,
    "A registration expires after it is created and within one presence TTL.",
  ),
);

/** The launcher's opaque name for one Downloads root it knows, never the path itself. */
export const RootIdSchema = v.pipe(v.string(), v.regex(/^r[0-9]{1,3}$/));

const RegistryPeerSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  fingerprint: FingerprintSchema,
  root: RootIdSchema,
  lastSeenAt: TimeSchema,
  expiresAt: TimeSchema,
  /** The boot of the registration it came from, so a peer of an earlier run is told apart. */
  boot: BootSchema,
});

export const RegistrySchema = v.strictObject({
  version: v.literal(1),
  namespace: NamespaceSchema,
  writtenAt: TimeSchema,
  launcher: v.strictObject({ boot: BootSchema, fingerprint: v.optional(FingerprintSchema) }),
  peers: v.pipe(
    v.record(ProfileIdSchema, RegistryPeerSchema),
    v.maxEntries(MAX_REGISTRY_PEERS),
    v.check(
      (peers) => Object.entries(peers).every(([key, peer]) => peer.profileId === key),
      "Each peer is filed under its own profile id.",
    ),
  ),
});

export type Registry = v.InferOutput<typeof RegistrySchema>;

// Made on call: a sum at load would stay in the production background, which reads no registry.
const registryFreshness = (): Freshness<Registry> => ({
  schema: RegistrySchema,
  createdAt: (registry) => registry.writtenAt,
  expiresAt: (registry) => registry.writtenAt + REGISTRY_TTL_MS,
  // A catalog stamped within the clock skew still counts.
  horizon: REGISTRY_TTL_MS + CLOCK_SKEW_MS,
});

/** Reads registry.json with readTolerant's rules: the last valid catalog stands until its TTL. */
export function readRegistry(
  text: string | undefined,
  previous: Registry | undefined,
  now = Date.now(),
): TolerantRead<Registry> {
  return readTolerantOf(registryFreshness(), text, previous, now);
}
