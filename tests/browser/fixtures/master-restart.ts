import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { bindHierarchy } from "../../e2e/fixtures/hierarchy.ts";
import { sendRaw } from "../../e2e/fixtures/profiles.ts";
import { arriving } from "../../experiments/fixtures/e5-run.ts";
import { POC_EXTENSION_ID, linkedPeers, storedIn, waitForMesh } from "./downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./downloads-profiles.ts";
import { within } from "./trust.ts";

/*
 * POC PLAN.md P3.5: the Default bound as the master of two workers over Downloads, and what the
 * master-absent, master-back, and worker-restart cases read: each profile's recorded hierarchy,
 * the session the master started in a worker, and the requests the master's dashboard sends.
 * Nothing here writes a profile's storage but bindHierarchy, which stands in for the launcher.
 */

export const HIERARCHY_NAMES = ["Default", "Worker 1", "Worker 2"] as const;
const MESH_MS = 60_000;
const DASHBOARD = `chrome-extension://${POC_EXTENSION_ID}/dashboard.html`;

/** The Default, bound as master, and its two workers, in launch order. */
export interface Hierarchy {
  master: DownloadsProfile;
  workers: [DownloadsProfile, DownloadsProfile];
}

/**
 * The Default and two workers, each with its presence out (`prepared` runs on each before the
 * catalog lists it), linked over Downloads; then the workers are bound to the Default.
 */
export async function boundHierarchy(
  group: DownloadsGroup,
  prepared?: (profile: DownloadsProfile) => Promise<void>,
): Promise<Hierarchy> {
  const profiles: DownloadsProfile[] = [];
  for (const name of HIERARCHY_NAMES) {
    const profile = await arriving(group, name);
    await prepared?.(profile);
    profiles.push(profile);
  }
  await group.catalog();
  group.startCatalog();
  await waitForMesh(profiles, MESH_MS);
  const [master, one, other] = profiles;
  if (!master || !one || !other) throw new Error("The hierarchy takes three profiles.");
  await bindHierarchy(master, [one, other]);
  return { master, workers: [one, other] };
}

/** What `profile` recorded of the hierarchy: its role, the workers it bound, and its pins. */
export async function hierarchyOf(profile: DownloadsProfile) {
  const read = (key: string) => storedIn(profile.serviceWorker, "local", key);
  const [role, boundWorkers, peerPins] = await Promise.all(
    ["role", "boundWorkers", "peerPins"].map(read),
  );
  return { role: role ?? null, boundWorkers: boundWorkers ?? null, peerPins: peerPins ?? {} };
}

/** The session recording in `profile` and the peer that started it, from its session storage. */
export async function workOf(profile: DownloadsProfile) {
  const [session, controller] = await Promise.all([
    storedIn(profile.serviceWorker, "session", "recording"),
    storedIn(profile.serviceWorker, "session", "remoteController"),
  ]);
  const controlledBy = (controller as { profileId?: string } | null | undefined)?.profileId;
  return { session: session ?? null, controlledBy: controlledBy ?? null };
}

/** A dashboard tab of `profile`: the background takes its requests as its own page's. */
export async function dashboardOf(profile: DownloadsProfile): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(DASHBOARD);
  return page;
}

type Reply = { ok: true; result?: unknown } | { ok: false; error: string };

interface ChromeGlobal {
  chrome: {
    runtime: { sendMessage(message: unknown): Promise<unknown> };
    tabs: {
      create(properties: { url: string; active: boolean }): Promise<{ id?: number }>;
      get(tabId: number): Promise<{ active: boolean }>;
    };
  };
}

/** A request about the other profiles from `page`, as the dashboard sends it, and its reply. */
export const askPeers = (page: Page, request: Record<string, unknown>) =>
  page.evaluate(
    (asked) =>
      (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
        type: "peer",
        request: asked,
      }),
    request,
  ) as Promise<Reply>;

/** A tab `profile` opens at `url` behind its current one; its id. */
export async function openTab(profile: DownloadsProfile, url: string): Promise<number> {
  const id = await profile.serviceWorker.evaluate(
    async (address) =>
      (
        await (globalThis as unknown as ChromeGlobal).chrome.tabs.create({
          url: address,
          active: false,
        })
      ).id,
    url,
  );
  if (id === undefined) throw new Error(`${profile.name} opened no tab.`);
  return id;
}

/** A tab `profile` opens behind its current one, titled `label`. */
export const tabOf = (profile: DownloadsProfile, label: string) =>
  openTab(profile, `data:text/html,<title>${encodeURIComponent(label)}</title>`);

/** Whether `profile`'s tab `tabId` is the active one of its window. */
export const isActive = (profile: DownloadsProfile, tabId: number) =>
  profile.serviceWorker.evaluate(
    async (id) => (await (globalThis as unknown as ChromeGlobal).chrome.tabs.get(id)).active,
    tabId,
  );

/** The master starts a session in a new tab of `worker` from its dashboard page, as Record does. */
export async function startWork(page: Page, worker: DownloadsProfile): Promise<number> {
  const tabId = await tabOf(worker, `${worker.name} work`);
  const reply = await askPeers(page, { type: "session-start", peer: worker.profileId, tabId });
  if (!reply.ok) throw new Error(`The master could not start a session: ${reply.error}`);
  return tabId;
}

/** How long until `profile` holds no verified link with `peer`, or undefined after `ms`. */
export async function goneFrom(profile: DownloadsProfile, peer: DownloadsProfile, ms: number) {
  const started = Date.now();
  const gone = await within(
    async () => ((await linkedPeers(profile)).includes(peer.profileId) ? undefined : true),
    ms,
  );
  return gone ? Date.now() - started : undefined;
}

/** Sends `message` from `from` to `to` over `from`'s own verified link, as its background would. */
export async function sendOverLink(
  from: DownloadsProfile,
  to: DownloadsProfile,
  message: Record<string, unknown>,
): Promise<void> {
  const route = { from: from.profileId, to: to.profileId };
  const frame = { channel: "recnrun-peer", protocol: 1, id: randomUUID(), ...route, ...message };
  const reply = await sendRaw(from, to.profileId, JSON.stringify(frame));
  if ((reply as { result?: { sent?: boolean } }).result?.sent !== true)
    throw new Error(`${from.name} could not send over its link to ${to.name}.`);
}

/** The lines of `log` from index `from` on that contain `text`. */
export const linesWith = (log: string[], text: string, from = 0) =>
  log.slice(from).filter((line) => line.includes(text));
