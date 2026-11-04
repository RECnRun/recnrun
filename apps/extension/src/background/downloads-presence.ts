import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { dataUrl, settled } from "@/background/downloads-publisher";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { ensureOffscreen } from "@/background/link";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import { PocFingerprintResultSchema, pocFingerprintRequest } from "@/messaging/poc-fingerprint";
import { NamespaceSchema } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { RegistrationSchema } from "@/p2p/registry";
import { readIdentity } from "@/storage/peer-repository";
import type { ProfileIdentity } from "@/storage/peer-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

/*
 * P2.2 (POC PLAN.md): each POC profile announces itself through Downloads as its worker starts,
 * with no folder chosen and no page open, and learns its Downloads root from Chrome's answer.
 */

/** The namespace a POC build joins unless `pocNamespace` in chrome.storage.local names another. */
const DEFAULT_NAMESPACE = "lab";
const SETTLE_MS = 10_000;

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
  return v.parse(RegistrationSchema, {
    ...identity,
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

/** Announces this profile now and every half TTL, so it never lapses while the worker runs. */
export function startDownloadsPresence(deps: PresenceDependencies) {
  const attempt = () =>
    void publish(deps).catch((error: unknown) => deps.log(`presence: ${errorMessage(error)}`));
  attempt();
  const timer = setInterval(attempt, PRESENCE_TTL_MS / 2);
  return { stop: () => clearInterval(timer) };
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
  return startDownloadsPresence({
    downloads: browser.downloads,
    identity: readIdentity,
    fingerprint: offscreenFingerprint,
    namespace: store.namespace,
    boot: store.boot,
    root: store.root,
    log,
  });
}
