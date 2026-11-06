/*
 * The cache rule of E3 (POC PLAN.md P1.4), apart from Chrome so a unit test can feed it a reader
 * that is stale once: the probe changes A→B→C→D, one poll apart, and every change must show on
 * the first read after it and still show one poll later.
 */

export type Read = { ok: true; status: number; text: string } | { ok: false; error: unknown };

// Same length on purpose: a cache keyed on size and a coarse mtime would miss the change.
export const VERSIONS = ["A", "B", "C", "D"].map((name) => `RECnRun E3 probe, version ${name}\n`);
const PREVIEW = 200;

export interface CacheIo {
  write: (text: string) => Promise<void>;
  read: (cache?: "no-store") => Promise<Read>;
  /** Waits one poll interval. */
  wait: () => Promise<void>;
}

/** What a read returned, without the whole text. */
export const summary = (read: Read) =>
  read.ok ? { ok: true, status: read.status, text: read.text.slice(0, PREVIEW) } : read;

const matches = (read: Read, text: string | undefined) => read.ok && read.text === text;

export interface CacheRun {
  observation: Record<string, unknown>;
  problems: string[];
}

const name = (version: string | undefined) => `version ${version?.trim().slice(-1) ?? "?"}`;

/** Names what a read returned when it was not `expected`: an older version or the failure. */
function seenAs(read: Read): string {
  if (!read.ok) return `an error (${JSON.stringify(read.error)})`;
  const known = VERSIONS.find((version) => version === read.text);
  return known ? name(known) : `${read.text.length} unexpected characters`;
}

interface Change {
  version: string;
  first: ReturnType<typeof summary>;
  noStore?: ReturnType<typeof summary>;
  afterPoll: ReturnType<typeof summary>;
}

/** Writes `version` one poll after the last read; its first read and the read a poll later must show it. */
async function change(io: CacheIo, version: string, problems: string[]): Promise<Change> {
  await io.wait();
  await io.write(version);
  const first = await io.read();
  const seen: Change = {
    version: version.trim().slice(-1),
    first: summary(first),
    afterPoll: summary(first),
  };
  if (!matches(first, version)) {
    problems.push(`the first read after ${name(version)} returned ${seenAs(first)}`);
    seen.noStore = summary(await io.read("no-store"));
  }
  await io.wait();
  const later = await io.read();
  seen.afterPoll = summary(later);
  if (!matches(later, version))
    problems.push(`the read one poll after ${name(version)} returned ${seenAs(later)}`);
  return seen;
}

/** A→B→C→D with the default cache mode; `no-store` is read only to note whether it would have helped. */
export async function cacheRun(io: CacheIo): Promise<CacheRun> {
  const [first, ...rest] = VERSIONS;
  const problems: string[] = [];
  await io.write(first ?? "");
  const before = await io.read();
  if (!matches(before, first)) problems.push(`the first read did not return ${name(first)}`);
  const changes: Change[] = [];
  for (const version of rest) changes.push(await change(io, version, problems));
  const noStoreNeeded = changes.some((seen) => seen.noStore !== undefined);
  return { observation: { before: summary(before), changes, noStoreNeeded }, problems };
}
