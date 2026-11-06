import * as v from "valibot";
import { PRESENCE_TTL_MS, PresenceSchema } from "@/p2p/folder-rendezvous";
import type { Presence } from "@/p2p/folder-rendezvous";
import { MAX_CODE_LENGTH, ProfileIdSchema } from "@/p2p/protocol";

/*
 * The Downloads + file:// rendezvous (POC PLAN.md §5): pure paths and the tolerant reader. The
 * chrome.downloads calls live in background/downloads-publisher.ts.
 */

const NAMESPACE = /^[a-z0-9-]{1,40}$/;
const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/]/;

/** A namespace names one folder under RECnRun/poc/, so it never carries a path character. */
export const NamespaceSchema = v.pipe(v.string(), v.regex(NAMESPACE));

/** The namespace a POC build joins unless `pocNamespace` in chrome.storage.local names another. */
export const DEFAULT_NAMESPACE = "lab";

/** The namespace's folder, relative to the Downloads root, as chrome.downloads requires. */
function namespaceFolder(namespace: string): string {
  if (!NAMESPACE.test(namespace)) {
    throw new Error(`Invalid namespace ${JSON.stringify(namespace)}: use [a-z0-9-]{1,40}.`);
  }
  return `RECnRun/poc/${namespace}`;
}

/** The probe's destination, relative to the Downloads root. */
export function probePath(namespace: string): string {
  return `${namespaceFolder(namespace)}/probe.json`;
}

/** The catalog the launcher alone writes (PLAN.md decision 11). */
export function registryPath(namespace: string): string {
  return `${namespaceFolder(namespace)}/registry.json`;
}

/** One file of a "Prepare workers" operation, in the folder the launcher scans (POC PLAN.md decision 11). */
export function operationPath(
  namespace: string,
  operationId: string,
  file: "request.json" | "status.json" | "retry",
): string {
  if (!v.is(TokenSchema, operationId)) {
    throw new Error(
      `Invalid operation id ${JSON.stringify(operationId)}: use a lowercase v4 uuid.`,
    );
  }
  return `${namespaceFolder(namespace)}/ops/${operationId}/${file}`;
}

/** One file of a clone-control request, in the folder the launcher scans (POC PLAN.md P7.5). */
export function controlPath(
  namespace: string,
  requestId: string,
  file: "request.json" | "status.json",
): string {
  if (!v.is(TokenSchema, requestId)) {
    throw new Error(`Invalid request id ${JSON.stringify(requestId)}: use a lowercase v4 uuid.`);
  }
  return `${namespaceFolder(namespace)}/control/${requestId}/${file}`;
}

/** The list of worker clones the launcher keeps for the master's dashboard. */
export function clonesStatePath(namespace: string): string {
  return `${namespaceFolder(namespace)}/control/clones.json`;
}

/** A profile id as a path segment, which only a uuid may be. */
function profileSegment(profileId: string): string {
  if (!v.is(ProfileIdSchema, profileId)) {
    throw new Error(`Invalid profile id ${JSON.stringify(profileId)}: use a uuid.`);
  }
  return profileId;
}

/** Where a profile publishes its presence; the launcher reads only this name in a uuid folder. */
export function presencePath(namespace: string, profileId: string): string {
  return `${namespaceFolder(namespace)}/peers/${profileSegment(profileId)}/presence.json`;
}

/** Where a profile states, for the launcher, that it left its master on purpose or returned. */
export function pausedPath(namespace: string, profileId: string): string {
  return `${namespaceFolder(namespace)}/peers/${profileSegment(profileId)}/paused.json`;
}

/** The lowercase v4 uuid the launcher gives each open attempt; nothing else may name an ack. */
export const TokenSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);

/** Where a profile answers one open attempt of the launcher, in its own folder. */
export function ackPath(namespace: string, profileId: string, token: string): string {
  if (!v.is(TokenSchema, token)) {
    throw new Error(`Invalid token ${JSON.stringify(token)}: use a lowercase v4 uuid.`);
  }
  return `${namespaceFolder(namespace)}/acks/${profileSegment(profileId)}/${token}.json`;
}

/** Where `from` leaves its one current signal of `kind` for `to`, in its own folder. */
export function signalPath(
  namespace: string,
  from: string,
  kind: "offer" | "answer",
  to: string,
): string {
  const folder = `${namespaceFolder(namespace)}/peers/${profileSegment(from)}`;
  return `${folder}/${kind}-${profileSegment(to)}.json`;
}

function encodedSegments(segments: string[], path: string): string {
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Refusing the path ${JSON.stringify(path)}: empty, . or .. segment.`);
  }
  return segments.map(encodeURIComponent).join("/");
}

/** The file URL of an absolute POSIX, Windows drive, or UNC path, as DownloadItem.filename reports it. */
export function fileUrlFor(absolutePath: string): string {
  if (absolutePath.startsWith("/")) {
    return `file:///${encodedSegments(absolutePath.slice(1).split("/"), absolutePath)}`;
  }
  if (DRIVE.test(absolutePath)) {
    const [drive = "", ...rest] = absolutePath.split(/[\\/]/);
    return `file:///${drive}/${encodedSegments(rest, absolutePath)}`;
  }
  if (UNC.test(absolutePath)) {
    const [host = "", ...rest] = absolutePath.slice(2).split(/[\\/]/);
    return `file://${host}/${encodedSegments(rest, absolutePath)}`;
  }
  throw new Error(`Refusing the path ${JSON.stringify(absolutePath)}: it is not absolute.`);
}

/** Why the reader kept or dropped what it had. */
type ReadReason = "fresh" | "absent" | "empty" | "partial" | "invalid" | "older" | "expired";

export interface TolerantRead<T = Presence> {
  /** The publication that counts now: the file's, or the last valid one until its TTL. */
  publication: T | undefined;
  reason: ReadReason;
}

/** How one kind of publication is validated and dated. */
export interface Freshness<T> {
  schema: v.GenericSchema<unknown, T>;
  createdAt: (publication: T) => number;
  expiresAt: (publication: T) => number;
  /** The furthest from now an expiry may be. */
  horizon: number;
}

/** How far ahead of this clock another profile's publication may be stamped. */
export const CLOCK_SKEW_MS = 5000;

const PRESENCE: Freshness<Presence> = {
  schema: PresenceSchema,
  createdAt: (presence) => presence.createdAt,
  expiresAt: (presence) => presence.expiresAt,
  horizon: PRESENCE_TTL_MS,
};

function parse(text: string): { value?: unknown; reason?: ReadReason } {
  if (text.trim() === "") return { reason: "empty" };
  if (text.length > MAX_CODE_LENGTH) return { reason: "invalid" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { reason: "partial" };
  }
}

/** Current, and never claiming to live longer than the horizon from now. */
const stands = <T>(kind: Freshness<T>, publication: T, now: number) =>
  kind.expiresAt(publication) > now && kind.expiresAt(publication) - now <= kind.horizon;

/** Why a well-formed publication does not replace the usable one, if it does not. */
function refusal<T>(
  kind: Freshness<T>,
  publication: T,
  usable: T | undefined,
  now: number,
): ReadReason | undefined {
  const createdAt = kind.createdAt(publication);
  if (createdAt > now + CLOCK_SKEW_MS) return "invalid";
  if (usable !== undefined && createdAt < kind.createdAt(usable)) return "older";
  if (kind.expiresAt(publication) <= now) return "expired";
  return stands(kind, publication, now) ? undefined : "invalid";
}

/**
 * Reads a publication from a file another writer may be replacing. An absent, empty, truncated,
 * or foreign file, or a temporary read error (passed as undefined), keeps the previous valid
 * publication until its TTL, an expired replacement included; an older one never replaces a newer one.
 */
export function readTolerantOf<T>(
  kind: Freshness<T>,
  text: string | undefined,
  previous: T | undefined,
  now = Date.now(),
): TolerantRead<T> {
  // An expired previous publication is not a basis for comparison or for keeping.
  const usable = previous !== undefined && stands(kind, previous, now) ? previous : undefined;
  const kept = (reason: ReadReason): TolerantRead<T> => ({ publication: usable, reason });
  if (text === undefined) return kept("absent");
  const { value, reason } = parse(text);
  if (reason) return kept(reason);
  const parsed = v.safeParse(kind.schema, value);
  if (!parsed.success) return kept("invalid");
  const publication = parsed.output;
  const refused = refusal(kind, publication, usable, now);
  return refused ? kept(refused) : { publication, reason: "fresh" };
}

/** Reads a presence with the rules of readTolerantOf. */
export function readTolerant(
  text: string | undefined,
  previous: Presence | undefined,
  now = Date.now(),
): TolerantRead {
  return readTolerantOf(PRESENCE, text, previous, now);
}
