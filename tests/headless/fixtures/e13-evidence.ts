import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { presenceIn } from "../../experiments/fixtures/e4-launcher.ts";
import { keepDisplayOnFailure, windowSummaries } from "../../browser/fixtures/x-display.ts";

/*
 * What a failed headed reopen leaves to read, beyond the launcher's words: the display, the
 * Downloads tree, the profile's exit state, the Singleton links, and the processes involved.
 */

const TREE_LIMIT = 80;
const WINDOW_LIMIT = 20;

/** Every path under `dir`, relative to it, directories with a trailing slash, at most TREE_LIMIT. */
async function listing(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string, rel: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (found.length >= TREE_LIMIT) return;
      found.push(entry.isDirectory() ? `${rel}${entry.name}/` : `${rel}${entry.name}`);
      if (entry.isDirectory()) await walk(join(path, entry.name), `${rel}${entry.name}/`);
    }
  };
  await walk(dir, "");
  return found;
}

/** The `boot` of the clone's presence.json in the Downloads tree, null when absent or invalid. */
async function boot(downloads: string, profileId: string): Promise<string | null> {
  const presence = await presenceIn(downloads, profileId).catch(() => null);
  return presence?.boot ?? null;
}

/** profile.exit_type and profile.exited_cleanly from the root's Preferences. */
async function exitState(root: string) {
  const raw = await readFile(join(root, "Default", "Preferences"), "utf8").catch(() => "");
  try {
    const { profile } = JSON.parse(raw) as { profile?: Record<string, unknown> };
    return { exitType: profile?.exit_type ?? null, exitedCleanly: profile?.exited_cleanly ?? null };
  } catch {
    return { exitType: null, exitedCleanly: null };
  }
}

/** Whether `pid` lives (its State line) and where its executable points. */
async function processOf(pid: number) {
  if (!(pid > 0)) return null;
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  return {
    pid,
    state: /^State:\s*(.*)$/m.exec(status)?.[1] ?? "gone",
    exe: await readlink(`/proc/${pid}/exe`).catch(() => null),
  };
}

/** A screenshot of the display saved under the test's output, and the titles and owners of its windows. */
async function display(testInfo: TestInfo) {
  const failed = {
    status: "failed" as const,
    expectedStatus: "passed" as const,
    outputPath: (name: string) => testInfo.outputPath(name),
  };
  const screenshot = await keepDisplayOnFailure(failed).then(
    () => testInfo.outputPath("display.png"),
    (error: unknown) => `not saved: ${String(error).slice(0, 120)}`,
  );
  const windows = await windowSummaries(".").catch(() => []);
  return { screenshot, windows: windows.slice(0, WINDOW_LIMIT) };
}

export interface Moments {
  quitEnded: number;
  reopenStarted: number;
}

export interface EvidenceOf {
  testInfo: TestInfo;
  root: string;
  downloads: string;
  profileId: string;
  launchedPid: number;
  chromeLog: string;
  moments: Moments;
}

/** The disk, display, and process facts about a root whose headed reopen failed. */
export async function reopenFacts(of: EvidenceOf) {
  const lock = await readlink(join(of.root, "SingletonLock")).catch(() => null);
  const lockPid = Number(/-(\d+)$/.exec(lock ?? "")?.[1] ?? 0);
  const logTime = await stat(of.chromeLog).then(
    (info) => info.mtimeMs,
    () => null,
  );
  return {
    display: await display(of.testInfo),
    downloadsTree: await listing(of.downloads),
    presenceBoot: await boot(of.downloads, of.profileId),
    ...(await exitState(of.root)),
    singletonSocket: await readlink(join(of.root, "SingletonSocket")).catch(() => null),
    singletonCookie: await readlink(join(of.root, "SingletonCookie")).catch(() => null),
    launchedProcess: await processOf(of.launchedPid),
    lockProcess: await processOf(lockPid),
    timestamps: { ...of.moments, failedAt: Date.now(), chromeLogMtime: logTime },
  };
}
