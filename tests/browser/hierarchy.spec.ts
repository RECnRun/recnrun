import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bindHierarchy } from "../e2e/fixtures/hierarchy.ts";
import { listOf } from "../e2e/fixtures/mesh.ts";
import type { Profile } from "../e2e/fixtures/profiles.ts";
import { storedSession } from "../e2e/fixtures/tabs.ts";
import { namespaceFolder } from "../experiments/fixtures/e4-launcher.ts";
import { signalFile } from "../experiments/fixtures/e5-virtual.ts";
import { expect, test as base } from "./fixtures/chrome.ts";
import {
  createDownloadsGroup,
  nameProfile,
  openViews,
  storedIn,
  tempPlatform,
  waitForMesh,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./fixtures/downloads-profiles.ts";
import { backgroundLog, within } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P3.4 on Google Chrome Stable: three poc-d0 roots link over Downloads, and the first
 * is bound as the others' master (bindHierarchy, standing in for the launcher record and the P5.3
 * bootstrap). A worker's commands, sent over its own verified DTLS link, are refused by the other
 * worker and by the master; the master's command runs in a worker, whose result and status reach
 * it; a worker's dashboard offers no control of other profiles; and a role=master a worker writes
 * into its presence, a signal, or a message changes no role.
 */

const NAMES = ["Profile A", "Profile B", "Profile C"];
const MESH_MS = 60_000;
const LOGGED_MS = 15_000;
/** A few polls of the Downloads watch (1 s) and catalog runs (2 s). */
const QUIET_MS = 6_000;
const NOT_MASTER = "Only the master controls other profiles";

interface Member {
  profile: DownloadsProfile;
  view: Profile;
  /** Its background's `[RECnRun peer]` lines since it launched. */
  log: string[];
}

interface Hierarchy {
  group: DownloadsGroup;
  baseURL: string;
  master: Member;
  workers: [Member, Member];
}

const test = base.extend<{ hierarchy: Hierarchy }>({
  hierarchy: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
    const group = await createDownloadsGroup(tempPlatform("recnrun-hierarchy"));
    try {
      const members: Member[] = [];
      for (const name of NAMES) {
        const profile = await group.launch(name);
        const view = await openViews(profile, baseURL);
        await nameProfile(view);
        members.push({ profile, view, log: backgroundLog(profile.context) });
      }
      await group.catalog();
      group.startCatalog();
      await waitForMesh(
        members.map((each) => each.profile),
        MESH_MS,
      );
      const [master, one, other] = members;
      if (!master || !one || !other) throw new Error("Three profiles did not launch.");
      await bindHierarchy(master.view, [one.view, other.view]);
      await use({ group, baseURL, master, workers: [one, other] });
    } finally {
      await group.dispose();
    }
  },
});

test.describe.configure({ timeout: 300_000 });

interface ChromeGlobal {
  chrome: {
    runtime: { sendMessage(message: unknown): Promise<unknown> };
    tabs: {
      create(properties: { url: string; active: boolean }): Promise<{ id?: number }>;
      get(tabId: number): Promise<{ active: boolean }>;
    };
  };
}

/** Sends `message` from `from` to `to` over `from`'s own verified link, as its background would. */
async function sendOverLink(from: Member, to: Member, message: Record<string, unknown>) {
  const route = { from: from.profile.profileId, to: to.profile.profileId };
  const frame = JSON.stringify({
    channel: "recnrun-peer",
    protocol: 1,
    id: randomUUID(),
    ...route,
    ...message,
  });
  const reply = await from.profile.serviceWorker.evaluate(
    ({ peer, text }) =>
      (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
        target: "offscreen",
        command: { type: "send", peer, frame: text },
      }),
    { peer: route.to, text: frame },
  );
  expect(reply).toEqual({ ok: true, result: { sent: true } });
}

/** A tab `member` opens behind its current one, at an address that names it. */
async function tabBehind({ profile, view }: Member, baseURL: string) {
  const url = new URL(`/privacy/?behind-${view.name.replace(" ", "-")}`, baseURL).href;
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
  if (id === undefined) throw new Error(`${view.name} opened no tab.`);
  return { id, url };
}

const isActive = ({ profile }: Member, tabId: number) =>
  profile.serviceWorker.evaluate(
    async (id) => (await (globalThis as unknown as ChromeGlobal).chrome.tabs.get(id)).active,
    tabId,
  );

/** The first line `member` logs from line `from` on that contains `text`, waiting for it. */
const logged = (member: Member, text: string, from = 0) =>
  within(async () => member.log.slice(from).find((line) => line.includes(text)), LOGGED_MS);

test("a worker's commands over its verified link are refused by another worker and by the master", async ({
  hierarchy,
}) => {
  const { baseURL, master, workers } = hierarchy;
  const [other, sender] = workers;
  const heard = sender.log.length;
  for (const to of [other, master]) {
    const tab = await tabBehind(to, baseURL);
    await sendOverLink(sender, to, { type: "ACTIVATE_TAB", tabId: tab.id });
    await sendOverLink(sender, to, { type: "SESSION_START", tabId: tab.id });
    for (const type of ["ACTIVATE_TAB", "SESSION_START"]) {
      const refusal = `REFUSED ${type} from ${sender.profile.profileId}: not the bound master`;
      expect(await logged(to, refusal), to.log.join("\n")).toBeDefined();
    }
    expect(await isActive(to, tab.id)).toBe(false);
    expect(await storedSession(to.profile.serviceWorker)).toBeNull();
  }
  // A refused command gets no answer at all.
  const answers = sender.log
    .slice(heard)
    .filter((line) => /received (COMMAND_RESULT|ERROR)/.test(line));
  expect(answers).toEqual([]);
});

test("the master's command runs in a worker, whose result and status reach the master", async ({
  hierarchy,
}) => {
  const { baseURL, master, workers } = hierarchy;
  const [worker, other] = workers;
  const from = master.log.length;
  const tab = await tabBehind(worker, baseURL);
  const item = listOf(master.view, worker.view).getByRole("listitem").filter({ hasText: tab.url });
  await item.getByRole("button", { name: "Show tab" }).click();
  await expect.poll(() => isActive(worker, tab.id)).toBe(true);
  expect(await logged(master, "received TABS_CHANGED", from)).toBeDefined();
  expect(await logged(master, "received COMMAND_RESULT", from)).toBeDefined();

  // A worker lists the other profiles' tabs, the master's too, with no control of them.
  for (const shown of [master, worker]) {
    const list = listOf(other.view, shown.view);
    await expect(list).toContainText(NOT_MASTER);
    await expect(list.getByRole("listitem").first()).toBeVisible();
    await expect(list.getByRole("button")).toHaveCount(0);
  }
  const body = await other.view.dashboard.screenshot({ fullPage: true });
  await test.info().attach(`dashboard of ${other.view.name}`, { body, contentType: "image/png" });
});

test("a role=master a worker writes into its presence, a signal, or a message changes no role", async ({
  hierarchy,
}) => {
  const { group, baseURL, master, workers } = hierarchy;
  const [other, forger] = workers;
  const members = [master, other, forger];
  const roles = () =>
    Promise.all(members.map(({ profile }) => storedIn(profile.serviceWorker, "local", "role")));
  const boundWorkers = () => storedIn(master.profile.serviceWorker, "local", "boundWorkers");
  const [rolesBefore, boundBefore] = [await roles(), await boundWorkers()];
  const peers = join(namespaceFolder(group.downloads), "peers", forger.profile.profileId);
  const presence = JSON.parse(await readFile(join(peers, "presence.json"), "utf8")) as object;
  await writeFile(join(peers, "presence.json"), JSON.stringify({ ...presence, role: "master" }));
  for (const to of [master, other]) {
    const signal = { kind: "offer", pairingId: randomUUID(), profileId: forger.profile.profileId };
    const stamped = { ...signal, to: to.profile.profileId, expiresAt: Date.now() + 60_000 };
    const path = signalFile(
      group.downloads,
      forger.profile.profileId,
      "offer",
      to.profile.profileId,
    );
    await writeFile(path, JSON.stringify({ ...stamped, code: "x", role: "master" }));
  }
  const tab = await tabBehind(other, baseURL);
  await sendOverLink(forger, other, { type: "SESSION_START", tabId: tab.id, role: "master" });
  expect(await logged(other, "dropped an invalid frame"), other.log.join("\n")).toBeDefined();
  await delay(QUIET_MS);

  expect(await roles()).toEqual(rolesBefore);
  expect(await boundWorkers()).toEqual(boundBefore);
  expect(await storedSession(other.profile.serviceWorker)).toBeNull();
  // Still a worker to the others: its next command is refused as before.
  await sendOverLink(forger, other, { type: "ACTIVATE_TAB", tabId: tab.id });
  const refusal = `REFUSED ACTIVATE_TAB from ${forger.profile.profileId}: not the bound master`;
  expect(await logged(other, refusal), other.log.join("\n")).toBeDefined();
  expect(await isActive(other, tab.id)).toBe(false);
  await expect(listOf(forger.view, master.view)).toContainText(NOT_MASTER);
});
