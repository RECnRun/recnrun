import * as v from "valibot";
import { NamespaceSchema } from "@/p2p/downloads-rendezvous";
import { FingerprintSchema } from "@/p2p/protocol";
import { RootIdSchema } from "@/p2p/registry";

/*
 * The launcher's own record, kept outside any profile (POC PLAN.md decision 11): blocks of
 * key=value lines separated by a blank line, in the closed format scripts/poc-cross-profile/
 * catalog.sh reads with the shell alone. The extension never writes it; it parses it in tests.
 */

const MAX_RECORD_LENGTH = 64 * 1024;
const KEYS = [
  "userDataDir",
  "profileDirectory",
  "profileId",
  "namespace",
  "role",
  "masterFingerprint",
  "downloadsRoot",
  "root",
] as const;
type Key = (typeof KEYS)[number];

/** An absolute directory the launcher found itself: a closed character set and no .. segment. */
const DirectorySchema = v.pipe(
  v.string(),
  v.maxLength(1024),
  v.regex(/^\/[A-Za-z0-9._:/ -]*$/),
  v.check((path) => !path.split("/").includes(".."), "A directory has no .. segment."),
);

/** A profile folder's name inside its user data directory, such as `Default` or `Profile 2`. */
const ProfileDirectorySchema = v.pipe(
  v.string(),
  v.maxLength(255),
  v.regex(/^[A-Za-z0-9._: -]+$/),
  v.check((name) => name !== "." && name !== "..", "A profile directory is a folder name."),
);

export const LauncherRecordSchema = v.pipe(
  v.strictObject({
    userDataDir: v.optional(DirectorySchema),
    profileDirectory: v.optional(ProfileDirectorySchema),
    // The launcher writes lower case, as crypto.randomUUID does, so the shell matches one form.
    profileId: v.optional(
      v.pipe(v.string(), v.regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
    ),
    namespace: v.optional(NamespaceSchema),
    role: v.optional(v.picklist(["master", "worker", "template"])),
    masterFingerprint: v.optional(FingerprintSchema),
    downloadsRoot: v.optional(DirectorySchema),
    root: v.optional(RootIdSchema),
  }),
  v.check(
    (record) => (record.userDataDir === undefined) === (record.profileDirectory === undefined),
    "A profile is its user data directory and its profile directory together.",
  ),
  v.check(
    (record) => record.userDataDir !== undefined || record.downloadsRoot !== undefined,
    "A record names a profile or a Downloads root.",
  ),
  v.check(
    (record) => record.root === undefined || record.downloadsRoot !== undefined,
    "A root id names a Downloads root of the same record.",
  ),
);

export type LauncherRecord = v.InferOutput<typeof LauncherRecordSchema>;

const isKey = (key: string): key is Key => (KEYS as readonly string[]).includes(key);

/** Adds one key=value line to the block; returns why it cannot. */
function addLine(block: Record<string, string>, line: string): string | undefined {
  const separator = line.indexOf("=");
  if (separator <= 0) return "expected key=value";
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);
  if (!isKey(key)) return `unknown key ${JSON.stringify(key)}`;
  if (key in block) return `repeated key ${JSON.stringify(key)}`;
  if (value === "") return `empty value for ${JSON.stringify(key)}`;
  block[key] = value;
  return undefined;
}

function recordOf(block: Record<string, string>, line: number): LauncherRecord {
  const parsed = v.safeParse(LauncherRecordSchema, block);
  if (parsed.success) return parsed.output;
  throw new Error(`Launcher record line ${line}: ${parsed.issues[0].message}`);
}

/** Parses the whole record file; throws with the line number on anything outside the format. */
export function parseLauncherRecord(text: string): LauncherRecord[] {
  if (text.length > MAX_RECORD_LENGTH) throw new Error("Launcher record too long.");
  if (text.includes("\r")) throw new Error("Launcher record has a carriage return.");
  const records: LauncherRecord[] = [];
  let block: Record<string, string> = {};
  let start = 0;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line === "") {
      if (start) records.push(recordOf(block, start));
      block = {};
      start = 0;
      return;
    }
    start ||= index + 1;
    const refused = addLine(block, line);
    if (refused) throw new Error(`Launcher record line ${index + 1}: ${refused}.`);
  });
  if (start) records.push(recordOf(block, start));
  return records;
}

/** Writes records in the fixed key order the shell expects, validating each first. */
export function serializeLauncherRecord(records: LauncherRecord[]): string {
  return records
    .map((record) => {
      const valid = v.parse(LauncherRecordSchema, record);
      return KEYS.filter((key) => valid[key] !== undefined)
        .map((key) => `${key}=${valid[key]}\n`)
        .join("");
    })
    .join("\n");
}
