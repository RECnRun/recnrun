import * as v from "valibot";
import { PRESENCE_TTL_MS, PresenceSchema } from "@/p2p/folder-rendezvous";
import type { Presence } from "@/p2p/folder-rendezvous";
import { MAX_CODE_LENGTH } from "@/p2p/protocol";

/*
 * The Downloads + file:// rendezvous (POC PLAN.md §5): pure paths and the tolerant reader. The
 * chrome.downloads calls live in background/downloads-publisher.ts.
 */

const NAMESPACE = /^[a-z0-9-]{1,40}$/;
const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/]/;

/** A namespace names one folder under RECnRun/poc/, so it never carries a path character. */
export const NamespaceSchema = v.pipe(v.string(), v.regex(NAMESPACE));

/** The probe's destination, relative to the Downloads root, as chrome.downloads requires. */
export function probePath(namespace: string): string {
  if (!NAMESPACE.test(namespace)) {
    throw new Error(`Invalid namespace ${JSON.stringify(namespace)}: use [a-z0-9-]{1,40}.`);
  }
  return `RECnRun/poc/${namespace}/probe.json`;
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

export interface TolerantRead {
  /** The publication that counts now: the file's, or the last valid one until its TTL. */
  publication: Presence | undefined;
  reason: ReadReason;
}

/** Current, and never claiming to live longer than one TTL from now. */
const stands = (publication: Presence, now: number) =>
  publication.expiresAt > now && publication.expiresAt - now <= PRESENCE_TTL_MS;

function parse(text: string): { value?: unknown; reason?: ReadReason } {
  if (text.trim() === "") return { reason: "empty" };
  if (text.length > MAX_CODE_LENGTH) return { reason: "invalid" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { reason: "partial" };
  }
}

/**
 * Reads a publication from a file another writer may be replacing. An absent, empty, truncated,
 * or foreign file, or a temporary read error (passed as undefined), keeps the previous valid
 * publication until its TTL; an older one never replaces a newer one.
 */
export function readTolerant(
  text: string | undefined,
  previous: Presence | undefined,
  now = Date.now(),
): TolerantRead {
  const kept = (reason: ReadReason): TolerantRead => ({
    publication: previous && stands(previous, now) ? previous : undefined,
    reason,
  });
  if (text === undefined) return kept("absent");
  const { value, reason } = parse(text);
  if (reason) return kept(reason);
  const parsed = v.safeParse(PresenceSchema, value);
  if (!parsed.success) return kept("invalid");
  const publication = parsed.output;
  if (previous && publication.createdAt < previous.createdAt) return kept("older");
  if (publication.expiresAt <= now) return { publication: undefined, reason: "expired" };
  if (!stands(publication, now)) return kept("invalid");
  return { publication, reason: "fresh" };
}
