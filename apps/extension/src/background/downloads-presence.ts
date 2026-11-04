import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { dataUrl, settled } from "@/background/downloads-publisher";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { ensureOffscreen } from "@/background/link";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocFingerprintResultSchema, pocFingerprintRequest } from "@/messaging/poc-fingerprint";
import { PocPublishPresenceSchema } from "@/messaging/poc-presence";
import { DEFAULT_NAMESPACE, NamespaceSchema } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { RegistrationSchema, registrationName } from "@/p2p/registry";
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
}

/** The presence's destination, relative to the Downloads root. */
const presencePath = (namespace: string, profileId: string) =>
  `RECnRun/poc/${namespace}/peers/${profileId}/presence.json`;

async function namespaceOf({ namespace, log }: PresenceDependencies): Promise<string> {
  const stored = await namespace();
  if (stored === undefined || stored === null) return DEFAULT_NAMESPACE;
  if (v.is(NamespaceSchema, stored)) return stored;
  log(`presence: ignored the stored namespace ${JSON.stringify(stored)}`);
  return DEFAULT_NAMESPACE;
}

/** The registration through its schema, so its keys follow the order the catalog parses and a path is refused. */
async function registration(deps: PresenceDependencies, namespace: string, now: number) {
  const identity = await deps.identity();
  const displayName = registrationName(identity.profileId, identity.displayName);
  if (displayName !== identity.displayName) {
    deps.log(`presence: published as "${displayName}", the stored name does not fit the catalog`);
  }
  return v.parse(RegistrationSchema, {
    ...identity,
    displayName,
    fingerprint: await deps.fingerprint(),
    createdAt: now,
    expiresAt: now + PRESENCE_TTL_MS,
    namespace,
    boot: await deps.boot(),
  });
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

async function publish(deps: PresenceDependencies) {
  const now = (deps.now ?? Date.now)();
  const namespace = await namespaceOf(deps);
  const presence = await registration(deps, namespace, now);
  const filename = presencePath(namespace, presence.profileId);
  const id = await deps.downloads.download({
    url: dataUrl(JSON.stringify(presence)),
    filename,
    saveAs: false,
    conflictAction: "overwrite",
  });
  await learnRoot(deps, id, filename);
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

/** Announces this profile now and every half TTL, so it never lapses while Chrome runs the profile. */
export function startDownloadsPresence(deps: PresenceDependencies) {
  const now = deps.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  const attempt = () => {
    last = now();
    void publish(deps).catch((error: unknown) => deps.log(`presence: ${errorMessage(error)}`));
  };
  attempt();
  // The alarm that restarted the worker arrives just after the write at start, which refreshed already.
  const stop = scheduleRefresh(() => {
    if (now() - last >= REFRESH_MS / 2) attempt();
  }, deps);
  return { stop, publish: () => publish(deps) };
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

/** The offscreen document's certificate fingerprint, creating the document first. */
async function offscreenFingerprint(): Promise<string> {
  await ensureOffscreen();
  const reply = v.safeParse(
    BackgroundReplySchema,
    await browser.runtime.sendMessage(pocFingerprintRequest()),
  );
  if (!reply.success) throw new Error("The offscreen document did not answer.");
  if (!reply.output.ok) throw new Error(reply.output.error);
  return v.parse(PocFingerprintResultSchema, reply.output.result).fingerprint;
}

/** The presence over Chrome's own Downloads, this profile's identity, and session storage. */
export function startPocPresence(log: (entry: string) => void) {
  const store = pocPresenceStore();
  const presence = startDownloadsPresence({
    downloads: browser.downloads,
    identity: readIdentity,
    fingerprint: offscreenFingerprint,
    namespace: store.namespace,
    boot: store.boot,
    root: store.root,
    log,
    // Undefined in a build without the alarms permission.
    alarms: (browser as { alarms?: AlarmsPort }).alarms,
  });
  const own = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createPublishListener(presence.publish, own));
  return presence;
}
