import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { startDownloadsPresence } from "@/background/downloads-presence";
import type { PresenceDependencies } from "@/background/downloads-presence";
import type { DownloadItem, DownloadsPort } from "@/background/downloads-publisher";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { FINGERPRINT, ME } from "./fake-peer";

const NOW = 1_700_000_000_000;
const BOOT = "99999999-9999-4999-8999-999999999999";
const PATH = `RECnRun/poc/lab/peers/${ME}/presence.json`;

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

  test("writes it again every half TTL, each with a newer createdAt, until stopped", async () => {
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

  test("logs a failed write and writes again at the next half TTL", async () => {
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
