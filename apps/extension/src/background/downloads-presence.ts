import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { createDownloadsPairing } from "@/background/downloads-pairing";
import { downloadsWriter, settled } from "@/background/downloads-publisher";
import type { DownloadsPort } from "@/background/downloads-publisher";
import type { Sign } from "@/background/greeting";
import { offscreenFingerprint } from "@/background/link";
import { createRendezvousRelay } from "@/background/rendezvous-relay";
import { presenceRenewal } from "@/background/presence-renewal";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocPublishPresenceSchema } from "@/messaging/poc-presence";
import { DEFAULT_NAMESPACE, NamespaceSchema, presencePath } from "@/p2p/downloads-rendezvous";
import { downloadsTransport } from "@/p2p/downloads-transport";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence } from "@/p2p/folder-rendezvous";
import { registrationName } from "@/p2p/registry";
import { readIdentity } from "@/storage/peer-repository";
import type { ProfileIdentity } from "@/storage/peer-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

/*
 * P2.2 (POC PLAN.md): each POC profile announces itself through Downloads as its worker starts,
 * with no folder chosen and no page open, and learns its Downloads root from Chrome's answer.
 */

const SETTLE_MS = 10_000;
const REFRESH_MS = PRESENCE_TTL_MS / 2;
/** The alarm that rewrites the presence, and wakes a stopped worker to do it (CHROMIUM.md group 12). */
const PRESENCE_ALARM = "poc-presence";

/** The part of `chrome.alarms` the presence uses. */
interface AlarmsPort {
  create(name: string, info: { periodInMinutes: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
  onAlarm: {
    addListener(listener: (alarm: { name: string }) => void): void;
    removeListener(listener: (alarm: { name: string }) => void): void;
  };
}

export interface PresenceDependencies {
  downloads: DownloadsPort;
  identity: () => Promise<ProfileIdentity>;
  /** This profile's DTLS certificate fingerprint, which only the offscreen document can read. */
  fingerprint: () => Promise<string>;
  /** Signs the statement each presence carries, naming the certificate it announces. */
  sign: Sign;
  /** The stored namespace override, not yet validated. */
  namespace: () => Promise<unknown>;
  /** This browser session's id, so a reader tells this run's presence from an earlier one. */
  boot: () => Promise<string>;
  /** The absolute Downloads root learned from Chrome. */
  root: { read(): Promise<string | null>; write(root: string): Promise<void> };
  log: (entry: string) => void;
  /** Chrome's alarms, absent without the permission; a timer then refreshes only while the worker runs. */
  alarms?: AlarmsPort;
  now?: () => number;
  /** Starts or restores pairing once the root is known, even when renewal is silenced. */
  published?: () => Promise<void>;
  /** POC-only renewal policy; an explicit bootstrap publication always writes. */
  renew?: () => Promise<boolean>;
}

async function namespaceOf({ namespace, log }: PresenceDependencies): Promise<string> {
  const stored = await namespace();
  if (stored === undefined || stored === null) return DEFAULT_NAMESPACE;
  if (v.is(NamespaceSchema, stored)) return stored;
  log(`presence: ignored the stored namespace ${JSON.stringify(stored)}`);
  return DEFAULT_NAMESPACE;
}

/** This profile's presence; the transport adds the namespace and the boot. */
async function presenceOf(deps: PresenceDependencies, now: number): Promise<Presence> {
  const me = await deps.identity();
  const displayName = registrationName(me.profileId, me.displayName);
  if (displayName !== me.displayName) {
    deps.log(`presence: published as "${displayName}", the stored name does not fit the catalog`);
  }
  const fingerprint = await deps.fingerprint();
  const identity = await deps.sign({ profileId: me.profileId, fingerprint });
  // The whole identity, so the registration schema refuses a key it does not know, a path included.
  return {
    ...me,
    displayName,
    fingerprint,
    identity,
    createdAt: now,
    expiresAt: now + PRESENCE_TTL_MS,
  };
}

/** The Downloads root of an absolute filename that ends with `relative`, in either separator. */
function rootOf(filename: string, relative: string): string | undefined {
  const separator = filename.includes("\\") && !filename.includes("/") ? "\\" : "/";
  const tail = separator + relative.replaceAll("/", separator);
  return filename.endsWith(tail) ? filename.slice(0, -tail.length) : undefined;
}

async function learnRoot(deps: PresenceDependencies, id: number, relative: string) {
  if ((await deps.root.read()) !== null) return;
  await settled(deps.downloads, id, SETTLE_MS);
  const [item] = await deps.downloads.search({ id });
  const root = item && rootOf(item.filename, relative);
  if (root === undefined) {
    deps.log(`presence: Chrome wrote ${JSON.stringify(item?.filename)}, not ${relative}`);
    return;
  }
  await deps.root.write(root);
}

/** Announces through the Downloads transport, keeping the item's id to learn the root from. */
async function publish(deps: PresenceDependencies) {
  const now = (deps.now ?? Date.now)();
  const namespace = await namespaceOf(deps);
  const presence = await presenceOf(deps, now);
  const writer = downloadsWriter(deps.downloads);
  let id: number | undefined;
  const transport = downloadsTransport({
    me: presence.profileId,
    context: async () => ({ namespace, root: await deps.root.read() }),
    boot: deps.boot,
    writer: { ...writer, write: async (path, text) => (id = await writer.write(path, text)) },
    read: () => Promise.reject(new Error("The offscreen document reads the others' files.")),
  });
  await transport.announce(presence);
  if (id !== undefined) await learnRoot(deps, id, presencePath(namespace, presence.profileId));
}

/** Calls `refresh` every half TTL; an alarm also restarts a stopped worker, a timer does not. */
function scheduleRefresh(refresh: () => void, { alarms, log }: PresenceDependencies) {
  if (!alarms) {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }
  const onAlarm = ({ name }: { name: string }) => {
    if (name === PRESENCE_ALARM) refresh();
  };
  // Added synchronously, so the alarm that restarts a stopped worker reaches this listener.
  alarms.onAlarm.addListener(onAlarm);
  alarms
    .create(PRESENCE_ALARM, { periodInMinutes: REFRESH_MS / 60_000 })
    .catch((error: unknown) => log(`presence: alarm: ${errorMessage(error)}`));
  return () => {
    alarms.onAlarm.removeListener(onAlarm);
    void alarms.clear(PRESENCE_ALARM).catch(() => false);
  };
}

/** Checks renewal at startup and every half TTL; explicit bootstrap publication always writes. */
export function startDownloadsPresence(deps: PresenceDependencies) {
  const now = deps.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  const publishNow = async () => {
    await publish(deps);
    // Not awaited: the bootstrap page's answer waits for the presence only.
    void deps.published?.();
  };
  const attempt = () => {
    last = now();
    void (async () => {
      if ((await deps.renew?.()) ?? true) await publishNow();
      else void deps.published?.();
    })().catch((error: unknown) => deps.log(`presence: ${errorMessage(error)}`));
  };
  attempt();
  // The alarm that restarted the worker arrives just after the startup renewal check.
  const stop = scheduleRefresh(() => {
    if (now() - last >= REFRESH_MS / 2) attempt();
  }, deps);
  return { stop, publish: publishNow };
}

interface Sender {
  id?: string;
  url?: string;
}

/** P2.1: the bootstrap page, once it stored the launcher's token as the boot, asks for a presence now. */
export function createPublishListener(
  publishNow: () => Promise<void>,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const ownPage = sender.id === own.extensionId && sender.url?.startsWith(own.extensionUrl);
    if (!v.is(PocPublishPresenceSchema, message) || !ownPage) return false;
    publishNow().then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}

interface PocPresenceOptions {
  log: (entry: string) => void;
  sign: Sign;
  startPairing: () => Promise<void>;
}

/**
 * The presence over Chrome's own Downloads, this profile's identity, and session storage; each
 * presence written once the root is known calls `startPairing`, the folder flow's start.
 * `available` tells whether Chrome reported the root yet.
 */
export function startPocPresence({ log, sign, startPairing }: PocPresenceOptions) {
  const store = pocPresenceStore();
  const available = async () => (await store.root.read()) !== null;
  const deps: PresenceDependencies = {
    downloads: browser.downloads,
    identity: readIdentity,
    fingerprint: offscreenFingerprint,
    sign,
    namespace: store.namespace,
    boot: store.boot,
    root: store.root,
    renew: presenceRenewal(store.root.read, log, store.policy),
    log,
    // Undefined in a build without the alarms permission.
    alarms: (browser as { alarms?: AlarmsPort }).alarms,
    published: createDownloadsPairing({
      available,
      start: startPairing,
      log,
    }),
  };
  const presence = startDownloadsPresence(deps);
  const own = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createPublishListener(presence.publish, own));
  const relay = {
    downloads: browser.downloads,
    me: async () => (await readIdentity()).profileId,
    namespace: () => namespaceOf(deps),
    boot: store.boot,
    root: () => store.root.read(),
  };
  browser.runtime.onMessage.addListener(createRendezvousRelay(relay, own));
  return { ...presence, available };
}
