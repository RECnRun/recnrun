import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createPublishListener, startDownloadsPresence } from "@/background/downloads-presence";
import type { PresenceDependencies } from "@/background/downloads-presence";
import type { DownloadItem, DownloadsPort } from "@/background/downloads-publisher";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { FINGERPRINT, ME } from "./fake-peer";

const NOW = 1_700_000_000_000;
const BOOT = "99999999-9999-4999-8999-999999999999";
const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const PATH = `RECnRun/poc/lab/peers/${ME}/presence.json`;
const ALARM = "poc-presence";
const HALF_TTL = PRESENCE_TTL_MS / 2;

type Written = Parameters<DownloadsPort["download"]>[0];

/** chrome.downloads whose items complete at once, at the absolute path `place` gives them. */
function fakeDownloads(
  place: (filename: string) => string = (name) => `/home/me/Downloads/${name}`,
) {
  const written: Written[] = [];
  const items: DownloadItem[] = [];
  const downloads = {
    download: vi.fn(async (options: Written) => {
      written.push(options);
      items.push({ id: items.length + 1, filename: place(options.filename), state: "complete" });
      return items.length;
    }),
    search: vi.fn(async ({ id }: { id?: number }) => items.filter((item) => item.id === id)),
    cancel: vi.fn(async () => {}),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } satisfies DownloadsPort;
  return { downloads, written };
}

function dependencies(overrides: Partial<PresenceDependencies> = {}) {
  let learned: string | null = null;
  const root = {
    read: vi.fn(async () => learned),
    write: vi.fn(async (next: string) => {
      learned = next;
    }),
  };
  const { downloads, written } = fakeDownloads();
  const log = vi.fn();
  const deps: PresenceDependencies = {
    downloads,
    identity: async () => ({ profileId: ME, displayName: "Laptop" }),
    fingerprint: async () => FINGERPRINT,
    namespace: async () => undefined,
    boot: async () => BOOT,
    root,
    log,
    now: () => Date.now(),
    ...overrides,
  };
  return { deps, written, root, log };
}

const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startDownloadsPresence", () => {
  test("writes this profile's presence under its namespace, keys in a fixed order, overwriting", async () => {
    const { deps, written } = dependencies();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(0);
    presence.stop();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      filename: PATH,
      saveAs: false,
      conflictAction: "overwrite",
    });
    expect(written[0]?.url.startsWith("data:application/json")).toBe(true);
    expect(contentOf(written[0]?.url ?? "")).toBe(
      `{"profileId":"${ME}","displayName":"Laptop","fingerprint":"${FINGERPRINT}",` +
        `"createdAt":${NOW},"expiresAt":${NOW + PRESENCE_TTL_MS},"namespace":"lab","boot":"${BOOT}"}`,
    );
  });

  test("writes exactly the registration's seven keys, in the schema's order", async () => {
    const { deps, written } = dependencies();
    startDownloadsPresence(deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(JSON.parse(contentOf(written[0]?.url ?? "")))).toEqual([
      "profileId",
      "displayName",
      "fingerprint",
      "createdAt",
      "expiresAt",
      "namespace",
      "boot",
    ]);
  });

  test("writes nothing, and logs, when the registration carries a key the schema refuses", async () => {
    const leaky = { profileId: ME, displayName: "Laptop", path: "/home/me/Downloads" };
    const { deps, written, log } = dependencies({ identity: async () => leaky });
    startDownloadsPresence(deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^presence: .*path/));
  });

  test("without alarms, writes it again every half TTL, each with a newer createdAt, until stopped", async () => {
    const { deps, written } = dependencies();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS / 2 - 1);
    expect(written).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(written).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS / 2);
    expect(written).toHaveLength(3);
    presence.stop();
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    expect(written).toHaveLength(3);

    const created = written.map((each) => JSON.parse(contentOf(each.url)).createdAt as number);
    expect(created).toEqual([NOW, NOW + PRESENCE_TTL_MS / 2, NOW + PRESENCE_TTL_MS]);
  });

  test("learns the Downloads root from the first write's filename, once", async () => {
    const { deps, root } = dependencies();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    presence.stop();
    expect(root.write.mock.calls).toEqual([["/home/me/Downloads"]]);
  });

  test("learns a Windows root, whose filename uses backslashes", async () => {
    const windows = (name: string) => `C:\\Users\\me\\Downloads\\${name.replaceAll("/", "\\")}`;
    const { deps, root } = dependencies({ downloads: fakeDownloads(windows).downloads });
    startDownloadsPresence(deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.write.mock.calls).toEqual([["C:\\Users\\me\\Downloads"]]);
  });

  test("logs, and stores no root from, a filename Chrome renamed", async () => {
    const renamed = (name: string) =>
      `/home/me/Downloads/${name.replace("presence.json", "presence (1).json")}`;
    const { deps, root, log } = dependencies({ downloads: fakeDownloads(renamed).downloads });
    startDownloadsPresence(deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("presence (1).json"));
  });

  test("uses the stored namespace, and the default when the stored one is not a namespace", async () => {
    const custom = dependencies({ namespace: async () => "e4-common" });
    startDownloadsPresence(custom.deps).stop();
    const invalid = dependencies({ namespace: async () => "../escape" });
    startDownloadsPresence(invalid.deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(custom.written[0]?.filename).toBe(`RECnRun/poc/e4-common/peers/${ME}/presence.json`);
    expect(invalid.written[0]?.filename).toBe(PATH);
    expect(invalid.log).toHaveBeenCalledWith(expect.stringContaining("../escape"));
  });

  test("writes again at once on request, with the boot as it now stands", async () => {
    let boot = BOOT;
    const { deps, written } = dependencies({ boot: async () => boot });
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(0);
    boot = TOKEN;
    await presence.publish();
    presence.stop();
    expect(written.map((each) => JSON.parse(contentOf(each.url)).boot)).toEqual([BOOT, TOKEN]);
  });

  test("without alarms, logs a failed write and writes again at the next half TTL", async () => {
    const { downloads, written } = fakeDownloads();
    downloads.download.mockRejectedValueOnce(new Error("Invalid filename"));
    const { deps, log } = dependencies({ downloads });
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid filename"));
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS / 2);
    presence.stop();
    expect(written).toHaveLength(1);
  });
});

describe("startDownloadsPresence with chrome.alarms", () => {
  const fire = (name = ALARM) =>
    fakeBrowser.alarms.onAlarm.trigger({
      name,
      scheduledTime: Date.now(),
      periodInMinutes: 0.5,
      persistAcrossSessions: true,
    });
  const withAlarms = () => dependencies({ alarms: fakeBrowser.alarms });

  test("listens before it returns, and creates a half-TTL alarm that wakes a stopped worker", async () => {
    const { deps } = withAlarms();
    const presence = startDownloadsPresence(deps);
    // MV3 delivers a waking event only to a listener the worker's first run added synchronously.
    expect(fakeBrowser.alarms.onAlarm.hasListeners()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await fakeBrowser.alarms.get(ALARM)).toMatchObject({
      name: ALARM,
      periodInMinutes: 0.5,
    });
    presence.stop();
  });

  test("writes at start, then on each alarm only, each with a newer createdAt", async () => {
    const { deps, written } = withAlarms();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    expect(written, "no timer writes when alarms exist").toHaveLength(1);
    await fire();
    await vi.advanceTimersByTimeAsync(HALF_TTL);
    await fire();
    await vi.advanceTimersByTimeAsync(0);
    presence.stop();
    const created = written.map((each) => JSON.parse(contentOf(each.url)).createdAt as number);
    expect(created).toEqual([NOW, NOW + PRESENCE_TTL_MS, NOW + PRESENCE_TTL_MS + HALF_TTL]);
  });

  test("writes nothing more for an alarm that arrives right after the write at start", async () => {
    const { deps, written } = withAlarms();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await fire();
    await vi.advanceTimersByTimeAsync(0);
    presence.stop();
    expect(written).toHaveLength(1);
  });

  test("ignores another alarm, and stops listening and clears its alarm when stopped", async () => {
    const { deps, written } = withAlarms();
    const presence = startDownloadsPresence(deps);
    await vi.advanceTimersByTimeAsync(HALF_TTL);
    await fire("another");
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toHaveLength(1);
    presence.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeBrowser.alarms.onAlarm.hasListeners()).toBe(false);
    expect(await fakeBrowser.alarms.get(ALARM)).toBeUndefined();
  });

  test("logs an alarm Chrome refuses, and still wrote at start", async () => {
    const alarms = {
      ...fakeBrowser.alarms,
      create: vi.fn(async () => Promise.reject(new Error("no"))),
    };
    const { deps, written, log } = dependencies({ alarms });
    startDownloadsPresence(deps).stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith("presence: alarm: no");
    expect(written).toHaveLength(1);
  });
});

describe("createPublishListener", () => {
  const own = { extensionId: "own", extensionUrl: "chrome-extension://own/" };
  const page = { id: "own", url: `chrome-extension://own/bootstrap.html#token=${TOKEN}` };
  const request = { type: "POC_PUBLISH_PRESENCE" };

  test("publishes for the extension's own page and replies once it is written", async () => {
    const publish = vi.fn(async () => {});
    const reply = vi.fn();
    expect(createPublishListener(publish, own)(request, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["another message", { type: "POC_DOWNLOAD_SEARCH" }, page],
    ["an extra key", { ...request, boot: TOKEN }, page],
    ["another extension", request, { ...page, id: "stranger" }],
    ["a web page", request, { id: "own", url: "https://recnrun.com/" }],
  ])("ignores %s", (_name, message, sender) => {
    const publish = vi.fn(async () => {});
    expect(createPublishListener(publish, own)(message, sender, vi.fn())).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  test("replies with the error of a failed write", async () => {
    const publish = vi.fn(async () => Promise.reject(new Error("Invalid filename")));
    const reply = vi.fn();
    createPublishListener(publish, own)(request, page, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ ok: false, error: "Invalid filename" }),
    );
  });
});
