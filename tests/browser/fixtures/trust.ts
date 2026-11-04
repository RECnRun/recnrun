import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Worker } from "@playwright/test";
import type { IdentityStatement } from "../../experiments/fixtures/identity-statement.ts";
import {
  POC_EXTENSION_ID,
  createDownloadsGroup,
  storedIn,
  tempPlatform,
  waitForMesh,
} from "./downloads-profiles.ts";
import { readOrAbsent } from "./absence.ts";
import type { DownloadsGroup, DownloadsProfile } from "./downloads-profiles.ts";

/*
 * What the P3.3 and P3.4 specs read from Downloads profiles: the pins (`local:peerPins`), a
 * profile's presence on disk, its background log, and the POC diagnostics hook that renews its
 * certificate. Nothing here writes a profile's storage.
 */

const POLL_MS = 250;
const DAY_MS = 86_400_000;
const LINK_MS = 60_000;

/** A pin as `p2p/pins.ts` stores it: the identity key and the last certificate it signed. */
interface Pin {
  identity: string;
  fingerprint: string;
  pinnedAt: number;
  source: string;
}

/** Two profiles linked over Downloads, with the launcher's catalog running. */
export interface Pair {
  group: DownloadsGroup;
  /** In launch order: Profile A, then Profile B. */
  profiles: [DownloadsProfile, DownloadsProfile];
  /** The lower profile id, which offers; the other answers (folder-pairing.ts). */
  offerer: DownloadsProfile;
  answerer: DownloadsProfile;
  /** Stops the launcher's catalog runs, as a forger who writes registry.json in its place would. */
  stopCatalog(): Promise<void>;
}

/** Runs `body` on two profiles that linked over Downloads, then closes them. */
export async function withPair(prefix: string, body: (pair: Pair) => Promise<void>) {
  const group = await createDownloadsGroup(tempPlatform(prefix));
  try {
    const profiles: Pair["profiles"] = [
      await group.launch("Profile A"),
      await group.launch("Profile B"),
    ];
    await group.catalog();
    const stopCatalog = group.startCatalog();
    await waitForMesh(profiles, LINK_MS);
    const [offerer, answerer] = [...profiles].sort((one, other) =>
      one.profileId < other.profileId ? -1 : 1,
    ) as Pair["profiles"];
    await body({ group, profiles, offerer, answerer, stopCatalog });
  } finally {
    await group.dispose();
  }
}

/** The pin `profile` holds for `peer`, if any. */
export async function pinOf(profile: DownloadsProfile, peer: DownloadsProfile) {
  const pins = (await storedIn(profile.serviceWorker, "local", "peerPins")) as
    | Record<string, Pin>
    | undefined;
  return pins?.[peer.profileId];
}

/** Polls `read` until it gives a value; undefined once `ms` passed. */
export async function within<T>(read: () => Promise<T | undefined>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await readOrAbsent(read);
    if (value !== undefined || Date.now() > deadline) return value;
    await delay(POLL_MS);
  }
}

interface Presence {
  fingerprint: string;
  identity: IdentityStatement;
}

/** The presence `profile` last wrote into the group's Downloads folder, read from disk. */
export async function presenceOf(group: DownloadsGroup, profile: DownloadsProfile) {
  const path = join(group.downloads, "RECnRun/poc/lab/peers", profile.profileId, "presence.json");
  return JSON.parse(await readFile(path, "utf8")) as Presence;
}

interface PocGlobal {
  __poc?: { renewCertificate?: (request: unknown) => Promise<{ fingerprint: string }> };
}

/**
 * Renews `profile`'s DTLS certificate through the POC diagnostics page, as an expiry would, then
 * restarts its Chrome so the offscreen document loads it; `discardIdentity` also drops its key.
 */
export async function renewAndRestart(
  group: DownloadsGroup,
  profile: DownloadsProfile,
  discardIdentity = false,
): Promise<string> {
  const page = await profile.context.newPage();
  await page.goto(`chrome-extension://${POC_EXTENSION_ID}/diagnostics.html`);
  await page.waitForFunction(
    () => typeof (window as PocGlobal).__poc?.renewCertificate === "function",
  );
  const request = { expires: 7 * DAY_MS, discardIdentity };
  const { fingerprint } = await page.evaluate(
    (asked) =>
      (window as PocGlobal).__poc?.renewCertificate?.(asked) ??
      Promise.reject(new Error("No hook.")),
    request,
  );
  await page.close();
  await group.quit(profile);
  await group.relaunch(profile);
  return fingerprint;
}

/** Every `[RECnRun peer]` line the background of `profile` logs from now on, worker restarts included. */
export function backgroundLog(context: BrowserContext): string[] {
  const lines: string[] = [];
  const listen = (worker: Worker) =>
    worker.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[RECnRun peer]")) lines.push(text);
    });
  for (const worker of context.serviceWorkers()) listen(worker);
  context.on("serviceworker", listen);
  return lines;
}
