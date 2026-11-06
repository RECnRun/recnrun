import { setTimeout as delay } from "node:timers/promises";

/*
 * Ending a Chrome the launcher scripts started, the way the scripts do. SIGINT takes Chrome's normal
 * shutdown (chrome_browser_main_posix.cc ExitHandler::Exit, chrome::AttemptExit), which ends in
 * ProcessSingleton::Cleanup and unlinks SingletonLock, SingletonSocket, and SingletonCookie. SIGTERM
 * takes chrome::SessionEnding instead, which exits at once and leaves them. Chrome's ShutdownDetector
 * reads one shutdown signal only, so a SIGTERM after the SIGINT changes nothing; the fallback is SIGKILL.
 */

/** The signal that ended the Chrome. */
export type Ended = "SIGINT" | "SIGKILL";

const POLL_MS = 200;

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    // A pid of 0 or below would signal a whole process group.
    if (pid <= 0) continue;
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

async function goneWithin(survivors: () => Promise<number[]>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while ((await survivors()).length > 0) {
    if (Date.now() > deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

/**
 * SIGINT to the main Chrome pids, then until `survivors` names none; after `ms`, SIGKILL to every
 * survivor and the same wait. Throws when a process still runs after both.
 */
export async function interruptChrome(
  mains: readonly number[],
  survivors: () => Promise<number[]>,
  ms: number,
): Promise<Ended> {
  signal(mains, "SIGINT");
  if (await goneWithin(survivors, ms)) return "SIGINT";
  const left = await survivors();
  console.warn(`Chrome pids ${left.join(",")} survived SIGINT for ${ms} ms: SIGKILL`);
  signal(left, "SIGKILL");
  if (await goneWithin(survivors, ms)) return "SIGKILL";
  throw new Error(`Chrome pids ${(await survivors()).join(",")} survived SIGINT and SIGKILL`);
}
