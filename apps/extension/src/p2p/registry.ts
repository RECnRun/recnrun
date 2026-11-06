import * as v from "valibot";
import { CLOCK_SKEW_MS, NamespaceSchema, readTolerantOf } from "@/p2p/downloads-rendezvous";
import type { Freshness, TolerantRead } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import { DisplayNameSchema } from "@/p2p/pairing-code";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";

/*
 * The catalog of the Downloads rendezvous (POC PLAN.md decision 11): what an extension registers
 * for the launcher, and the registry.json the launcher alone writes back. A registration carries
 * no path: the launcher learns a Downloads root from its record, names it with an opaque id, and
 * publishes the id's path in `roots`.
 */

/** The catalog outlives two presence periods, so one missed launcher pass drops nobody. */
export const REGISTRY_TTL_MS = 2 * PRESENCE_TTL_MS;
export const MAX_REGISTRY_PEERS = 32;

const BootSchema = v.pipe(v.string(), v.uuid());
const TimeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const MAX_NAME_BYTES = 64;

/** Written by JSON.stringify as is: no quote, backslash, control character, or lone surrogate. */
const unescaped = (name: string) =>
  JSON.stringify(name) === `"${name}"` && !name.includes("\u007f");

/**
 * The display name catalog.sh lists: 1 to 64 UTF-8 bytes, no quote, backslash, control
 * character, or edge space. Checked, never trimmed, so the published bytes are the ones checked.
 */
export const RegistrationNameSchema = v.pipe(
  v.string(),
  v.check((name) => {
    const bytes = new TextEncoder().encode(name).length;
    return bytes >= 1 && bytes <= MAX_NAME_BYTES && !/^ | $/.test(name) && unescaped(name);
  }, "The display name must be 1 to 64 UTF-8 bytes with no quote, backslash, control character, or edge space."),
);

/** The stored name if the catalog lists it, else the default name a new profile gets. */
export function registrationName(profileId: string, displayName: string): string {
  if (v.is(RegistrationNameSchema, displayName)) return displayName;
  return `Profile ${profileId.slice(0, 4).toUpperCase()}`;
}

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
    displayName: RegistrationNameSchema,
    fingerprint: FingerprintSchema,
    identity: IdentityStatementSchema,
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

/** The launcher's opaque name for one Downloads root it knows, as peers name it. */
export const RootIdSchema = v.pipe(v.string(), v.regex(/^r[0-9]{1,3}$/));

/** Every segment after the leading / or drive is one fileUrlFor accepts: never empty, . or .. */
const plainSegments = (path: string) =>
  path
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * The absolute path the launcher learned for a root, in the record's charset (record.sh):
 * 1 to 1024 characters of [A-Za-z0-9._:/ -], from / or a drive, with no trailing slash.
 */
const RootPathSchema = v.pipe(
  v.string(),
  v.maxLength(1024),
  v.regex(/^([A-Za-z]:)?\/[A-Za-z0-9._:/ -]*$/),
  v.check(plainSegments, "A root path has no empty, . or .. segment."),
);

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

/** One profile the catalog lists, with the opaque id of the Downloads root it writes under. */
export type RegistryPeer = v.InferOutput<typeof RegistryPeerSchema>;

export const RegistrySchema = v.strictObject({
  version: v.literal(1),
  namespace: NamespaceSchema,
  writtenAt: TimeSchema,
  launcher: v.strictObject({ boot: BootSchema, fingerprint: v.optional(FingerprintSchema) }),
  /** Where each root is, so an extension reads a listed peer's files under its peer's root. */
  roots: v.record(RootIdSchema, RootPathSchema),
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
