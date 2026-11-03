import { describe, expect, test } from "vite-plus/test";
import { LabChannel } from "@/background/lab/channel";
import { labConfigOf } from "@/background/lab/schema";
import type { LabApis, LabJournal, ReportInjection } from "@/background/lab/types";
import type { SessionRule } from "@/background/selection/types";
import type { TargetInfo } from "@/background/probes/types";
import { fakeDebugger } from "./fake-debugger";

// E8: the strict lab's channel, configured by chrome.storage.managed and read from what it posts.
const JOURNAL = "http://lab.localhost:9000/lab";
const APP = "http://app.localhost:4600";
const TAB = 7;
const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: `${APP}/sw.html?sw=classic`, attached: false, tabId: TAB },
  { type: "worker", id: "sw", url: `${APP}/sw-main.js?variant=classic`, attached: false },
  { type: "worker", id: "self", url: "chrome-extension://isolator/background.js", attached: false },
];
const REPLIES = {
  "IndexedDB.requestDatabaseNames": { databaseNames: ["__rec:lab-t7:fixture-sw"] },
  "CacheStorage.requestCacheNames": { caches: [{ cacheName: "__rec:lab-t7:fixture-sw" }] },
};

function setup(lab: unknown) {
  const fake = fakeDebugger({ targets: TARGETS, replies: REPLIES });
  const posts: { url: string; body: unknown }[] = [];
  const injections: ReportInjection[] = [];
  const rules: SessionRule[] = [];
  const managed: Record<string, unknown> = lab === undefined ? {} : { lab };
  const apis: LabApis = {
    debugger: fake.api,
    managed: { get: async () => managed },
    scripting: {
      executeScript: async (injection) => {
        injections.push(injection);
        return [{ result: '{"worker":{"database":"__rec:lab-t7:fixture-sw"}}' }];
      },
    },
    selection: {
      debugger: fake.api,
      dnr: {
        updateSessionRules: async ({ addRules = [] }) => void rules.push(...addRules),
        getSessionRules: async () => rules,
      },
      storage: { get: async () => ({}), set: async () => undefined },
      extensionOrigin: "chrome-extension://isolator/",
    },
    extensionOrigin: "chrome-extension://isolator/",
    id: "isolator",
    version: "0.1.0",
    post: async (url, body) => void posts.push({ url, body }),
  };
  let clock = 0;
  const channel = new LabChannel(() => apis, {
    now: () => (clock += 1),
    timeOrigin: 42,
    schedule: () => undefined,
  });
  const journal = () => posts.at(-1)?.body as LabJournal;
  return { channel, fake, posts, injections, rules, managed, journal };
}

async function settle(channel: LabChannel, tabId = TAB): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  channel.tabUpdated(tabId, {}, {});
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ARM = { origin: APP, pauseBeforeScript: true, clear: true };

describe("labConfigOf", () => {
  test("is undefined without the key and refuses a journal off *.localhost", () => {
    expect(labConfigOf({})).toBeUndefined();
    expect(() => labConfigOf({ lab: { journalUrl: "https://example.com/lab" } })).toThrow(
      "journalUrl must be http://<name>.localhost",
    );
    expect(labConfigOf({ lab: { journalUrl: JOURNAL } })).toMatchObject({ marker: "lab" });
  });
});

describe("LabChannel", () => {
  test("posts the targets it found before arming, and a journal only when it changed", async () => {
    const { channel, posts } = setup({ journalUrl: JOURNAL });
    await channel.start();
    expect(posts[0]).toEqual({
      url: JOURNAL,
      body: {
        event: "loaded",
        id: "isolator",
        version: "0.1.0",
        timeOrigin: 42,
        targets: expect.any(Array),
      },
    });
    expect(await channel.flush()).toBe(true);
    expect(await channel.flush()).toBe(false);
    expect(posts).toHaveLength(2);
  });

  test("stays silent with an invalid value and records why", async () => {
    const { channel, posts } = setup({ journalUrl: "http://127.0.0.1:9000/lab" });
    await channel.start();
    expect(await channel.flush()).toBe(false);
    expect(posts).toEqual([]);
  });

  test("arms a tab at its first loaded page of the origin, clears it, then reads its next page", async () => {
    const { channel, fake, injections, journal } = setup({ journalUrl: JOURNAL, arm: ARM });
    await channel.start();
    channel.tabUpdated(TAB, { status: "complete" }, { url: `${APP}/offline.html` });
    channel.tabUpdated(9, { status: "complete" }, { url: "http://idp.localhost:4602/" });
    await settle(channel);
    const clear = fake.sent.find((sent) => sent.method === "Storage.clearDataForOrigin");
    expect(clear).toMatchObject({ target: { tabId: TAB }, params: { origin: APP } });
    channel.tabUpdated(TAB, { status: "complete" }, { url: `${APP}/sw.html?sw=classic` });
    await settle(channel);
    await channel.flush();
    expect(journal().armed).toEqual([
      { tabId: TAB, url: `${APP}/offline.html`, marker: "lab-t7", route: "a", at: 1, cleared: APP },
    ]);
    expect(journal().routeA.marker).toBe("lab-t7");
    expect(injections).toMatchObject([{ target: { tabId: TAB }, world: "ISOLATED" }]);
    expect(journal().pages).toMatchObject([
      {
        tabId: TAB,
        marker: "lab-t7",
        report: '{"worker":{"database":"__rec:lab-t7:fixture-sw"}}',
        indexedDB: ["__rec:lab-t7:fixture-sw"],
        cacheStorage: ["__rec:lab-t7:fixture-sw"],
      },
    ]);
  });

  test("closes the origin's workers once per stop id and applies a new selection", async () => {
    const lab = { journalUrl: JOURNAL, stop: { id: "1", origin: APP } };
    const { channel, fake, managed, rules, journal } = setup(lab);
    await channel.start();
    const closes = () => fake.sent.filter((sent) => sent.method === "Target.closeTarget");
    expect(closes().map((sent) => sent.params)).toEqual([{ targetId: "sw" }]);
    await channel.managedChanged();
    expect(closes()).toHaveLength(1);
    managed.lab = { ...lab, selection: { slot: 3, origins: [APP] } };
    await channel.managedChanged();
    expect(rules.length).toBeGreaterThan(0);
    await channel.flush();
    expect(journal().commands.map((command) => command.key)).toEqual([
      "stop:1",
      `select:${JSON.stringify({ slot: 3, origins: [APP] })}`,
    ]);
  });

  test("clears an armed tab's origin through its session, once per id", async () => {
    const lab = { journalUrl: JOURNAL, arm: { ...ARM, clear: false } };
    const { channel, fake, managed, journal } = setup(lab);
    await channel.start();
    channel.tabUpdated(TAB, { status: "complete" }, { url: `${APP}/offline.html` });
    await settle(channel);
    managed.lab = { ...lab, clear: { id: "1", tabId: TAB } };
    await channel.managedChanged();
    await channel.managedChanged();
    const clears = fake.sent.filter((sent) => sent.method === "Storage.clearDataForOrigin");
    expect(clears.map((sent) => sent.params)).toMatchObject([{ origin: APP }]);
    await channel.flush();
    expect(journal().commands).toMatchObject([{ key: "clear:1", result: { origin: APP } }]);
  });

  test("starts when the policy delivers the key after a start without it", async () => {
    const { channel, managed, posts } = setup(undefined);
    await channel.start();
    await channel.managedChanged();
    expect(posts).toEqual([]);
    managed.lab = { journalUrl: JOURNAL };
    await channel.managedChanged();
    expect(posts.map((post) => (post.body as { event: string }).event)).toEqual(["loaded"]);
  });
});
