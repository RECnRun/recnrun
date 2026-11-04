import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readOrAbsent } from "../../browser/fixtures/absence.ts";
import { connectWebSocket } from "../../browser/fixtures/cdp-client.ts";
import { POC_EXTENSION_ID, storedIn } from "../../browser/fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";
import { namespaceFolder } from "./e4-launcher.ts";
import { readSignal, signalFile } from "./e5-virtual.ts";
import type { StampedSignal } from "./e5-virtual.ts";

/*
 * What E5 reads: files on disk, each profile's storage through its own worker, and the targets
 * Chrome lists over a client that attaches to nothing. No observation carries a path.
 */

const SAMPLE_MS = 25;

/** Polls `read` until it gives a value or `ms` pass: the value and when it came, or undefined; only absence is retried. */
export async function within<T>(
  read: () => Promise<T | undefined>,
  ms: number,
  every = SAMPLE_MS,
): Promise<{ value: T; at: number } | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await readOrAbsent(read);
    if (value !== undefined) return { value, at: Date.now() };
    if (Date.now() > deadline) return undefined;
    await delay(every);
  }
}

/** A signal file once it holds a signal `match` accepts, and the mtime Chrome or the test gave it. */
export async function signalLands(
  path: string,
  ms: number,
  match: (signal: StampedSignal) => boolean = () => true,
  every = SAMPLE_MS,
): Promise<{ signal: StampedSignal; mtimeMs: number } | undefined> {
  const read = async () => {
    const signal = await readSignal(path);
    return signal && match(signal) ? { signal, mtimeMs: (await stat(path)).mtimeMs } : undefined;
  };
  return (await within(read, ms, every))?.value;
}

/** The signal of `kind` that `from` left for `to` under the shared folder, as it stands now. */
export const signalNow = (
  downloads: string,
  from: DownloadsProfile | string,
  kind: StampedSignal["kind"],
  to: DownloadsProfile | string,
) => readSignal(signalFile(downloads, idOf(from), kind, idOf(to)));

const idOf = (profile: DownloadsProfile | string) =>
  typeof profile === "string" ? profile : profile.profileId;

/** The profile's stored record for `peer` under `key`, if any. */
export async function recordOf(
  profile: DownloadsProfile,
  area: "local" | "session",
  key: string,
  peer: DownloadsProfile | string,
): Promise<unknown> {
  const records = (await storedIn(profile.serviceWorker, area, key)) as
    | Record<string, unknown>
    | undefined;
  return records?.[idOf(peer)];
}

interface HistoryItem {
  filename: string;
  url: string;
  startTime: string;
  endTime?: string;
}

interface DownloadsGlobal {
  chrome: { downloads: { search(query: object): Promise<HistoryItem[]> } };
}

/** One signal a profile wrote, as Chrome's history keeps it: the item's data: URL holds the file. */
export interface SignalWrite {
  name: string;
  pairingId: string;
  startedAt: number;
  endedAt?: number;
}

const pairingIdOf = (url: string): string | undefined => {
  try {
    const parsed = JSON.parse(decodeURIComponent(url.slice(url.indexOf(",") + 1))) as {
      pairingId?: unknown;
    };
    return typeof parsed.pairingId === "string" ? parsed.pairingId : undefined;
  } catch {
    return undefined;
  }
};

/** Every signal file `profile` wrote in this run, oldest first, read from its own download history. */
export async function signalWrites(profile: DownloadsProfile): Promise<SignalWrite[]> {
  const items = await profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as DownloadsGlobal;
    return (await chrome.downloads.search({ orderBy: ["startTime"] })).map(
      ({ filename, url, startTime, endTime }) => ({ filename, url, startTime, endTime }),
    );
  });
  return items.flatMap(({ filename, url, startTime, endTime }) => {
    const pairingId = pairingIdOf(url);
    const name = filename.slice(filename.lastIndexOf("/") + 1);
    if (!pairingId || !/^(offer|answer)-/.test(name)) return [];
    const ended = endTime === undefined ? {} : { endedAt: Date.parse(endTime) };
    return [{ name, pairingId, startedAt: Date.parse(startTime), ...ended }];
  });
}

/** How many writes Chrome's own history lists for this profile's file `name` (one item each). */
export const writesOf = (profile: DownloadsProfile, name: string): Promise<number> =>
  profile.serviceWorker.evaluate(async (suffix) => {
    const { chrome } = globalThis as unknown as DownloadsGlobal;
    return (await chrome.downloads.search({})).filter((item) => item.filename.endsWith(suffix))
      .length;
  }, `/${name}`);

/** Whether Chrome lists poc-d0's service worker now, read without attaching to anything. */
export async function workerListed(profile: DownloadsProfile): Promise<boolean> {
  const client = await connectWebSocket(profile.chrome.wsEndpoint);
  try {
    const { targetInfos } = await client.send<{ targetInfos: { type: string; url: string }[] }>(
      "Target.getTargets",
    );
    const prefix = `chrome-extension://${POC_EXTENSION_ID}/`;
    return targetInfos.some(
      (each) => each.type === "service_worker" && each.url.startsWith(prefix),
    );
  } finally {
    client.close();
  }
}

const PresenceStampSchema = { createdAt: 0, boot: "" };

/** The createdAt and boot of a profile's presence on disk, or undefined. */
export async function presenceStamp(downloads: string, profileId: string) {
  const path = join(namespaceFolder(downloads), "peers", profileId, "presence.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as typeof PresenceStampSchema;
    return { createdAt: parsed.createdAt, boot: parsed.boot };
  } catch {
    return undefined;
  }
}

/** Every distinct presence a profile wrote on disk during `ms`, sampled each second: their createdAt. */
export async function presenceRewrites(
  downloads: string,
  profileId: string,
  ms: number,
): Promise<number[]> {
  const seen: number[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const stamp = await presenceStamp(downloads, profileId);
    if (stamp && stamp.createdAt !== seen.at(-1)) seen.push(stamp.createdAt);
    await delay(1_000);
  }
  return seen;
}

/** The longest time between consecutive stamps, and from the last one to `until`. */
export const longestGap = (stamps: number[], until: number) =>
  Math.max(
    ...stamps.slice(1).map((at, index) => at - (stamps[index] ?? at)),
    until - (stamps.at(-1) ?? 0),
  );

/** The background's pairing log of `profile` from now on, while its worker stays attached. */
export function pairingLog(profile: DownloadsProfile): () => string[] {
  const lines: string[] = [];
  profile.serviceWorker.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[RECnRun peer]")) lines.push(text.slice("[RECnRun peer] ".length));
  });
  return () => [...lines];
}
