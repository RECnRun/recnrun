import { describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  createDownloadsListener,
  downloadsWriter,
  startDownloadsPublisher,
} from "@/background/downloads-publisher";
import type { DownloadItem, DownloadsPort } from "@/background/downloads-publisher";

const ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const identity = { extensionId: ID, extensionUrl: `chrome-extension://${ID}/` };
const diagnostics = { id: ID, url: `chrome-extension://${ID}/diagnostics.html` };
const ROOT = "/home/me/Downloads/";

type Delta = Parameters<Parameters<DownloadsPort["onChanged"]["addListener"]>[0]>[0];

/** chrome.downloads as the publisher sees it: items settle when the test says so. */
function fakeDownloads(options: { refuse?: string; settledAtStart?: boolean } = {}) {
  const items = new Map<number, DownloadItem>();
  const listeners = new Set<(delta: Delta) => void>();
  const finish = (id: number, state: string, error?: string) => {
    const item = items.get(id);
    if (!item) return;
    items.set(id, { ...item, state, ...(error ? { error } : {}) });
    for (const listener of listeners) listener({ id, state: { current: state } });
  };
  const downloads = {
    download: vi.fn(async ({ filename }: { filename: string }) => {
      if (options.refuse) throw new Error(options.refuse);
      const id = items.size + 1;
      const state = options.settledAtStart ? "complete" : "in_progress";
      items.set(id, { id, filename: ROOT + filename, state, exists: true, bytesReceived: 2 });
      return id;
    }),
    search: vi.fn(async ({ id }: { id?: number }) =>
      [...items.values()].filter((item) => id === undefined || item.id === id),
    ),
    cancel: vi.fn(async (id: number) => finish(id, "interrupted", "USER_CANCELED")),
    onChanged: {
      addListener: (listener: (delta: Delta) => void) => listeners.add(listener),
      removeListener: (listener: (delta: Delta) => void) => listeners.delete(listener),
    },
  } satisfies DownloadsPort;
  return { downloads, finish, listeners };
}

/** Delivers one message as Chrome would; resolves with the reply, or "ignored". */
async function deliver(
  listener: ReturnType<typeof createDownloadsListener>,
  message: unknown,
  sender: { id?: string; url?: string } = diagnostics,
) {
  let reply: unknown;
  const handled = listener(message, sender, (value) => (reply = value));
  if (!handled) return "ignored";
  await vi.waitFor(() => expect(reply).toBeDefined());
  return reply;
}

describe("POC_DOWNLOAD_PROBE", () => {
  test("writes the probe through a data URL and answers with the absolute path once complete", async () => {
    const { downloads, finish } = fakeDownloads();
    const listener = createDownloadsListener(downloads, identity);
    const content = '{"a":"é 100% #1 ?"}';
    const replied = deliver(listener, { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content });
    await vi.waitFor(() => expect(downloads.download).toHaveBeenCalled());
    finish(1, "complete");
    expect(await replied).toEqual({
      ok: true,
      result: {
        id: 1,
        filename: `${ROOT}RECnRun/poc/lab/probe.json`,
        state: "complete",
        exists: true,
        bytesReceived: 2,
      },
    });
    expect(downloads.download).toHaveBeenCalledWith({
      url: `data:application/json;charset=utf-8,${encodeURIComponent(content)}`,
      filename: "RECnRun/poc/lab/probe.json",
      saveAs: false,
      conflictAction: "overwrite",
    });
  });

  test("passes a raw filename, a loopback source, and the conflict action through", async () => {
    const { downloads } = fakeDownloads({ settledAtStart: true });
    const listener = createDownloadsListener(downloads, identity);
    const message = {
      type: "POC_DOWNLOAD_PROBE",
      namespace: "lab",
      content: "",
      filename: "RECnRun/poc/lab/a b.json",
      url: "http://127.0.0.1:4321/slow",
      conflictAction: "uniquify",
    };
    expect(await deliver(listener, message)).toMatchObject({ ok: true, result: { id: 1 } });
    expect(downloads.download).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4321/slow",
      filename: "RECnRun/poc/lab/a b.json",
      saveAs: false,
      conflictAction: "uniquify",
    });
  });

  test("answers with the error Chrome gave when it refuses the filename", async () => {
    const { downloads } = fakeDownloads({ refuse: "Invalid filename" });
    const listener = createDownloadsListener(downloads, identity);
    const message = { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content: "", filename: "/x" };
    expect(await deliver(listener, message)).toEqual({ ok: false, error: "Invalid filename" });
  });

  test("answers at once when asked not to wait, and after the deadline when nothing settles", async () => {
    const { downloads, listeners } = fakeDownloads();
    const quick = createDownloadsListener(downloads, identity, 20);
    const base = { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content: "x" };
    expect(await deliver(quick, { ...base, settle: false })).toMatchObject({
      result: { id: 1, state: "in_progress" },
    });
    expect(await deliver(quick, base)).toMatchObject({ result: { id: 2, state: "in_progress" } });
    expect(listeners.size).toBe(0);
  });

  test("ignores a namespace off the pattern, a remote source, and a page that is not the extension's", async () => {
    const { downloads } = fakeDownloads();
    const listener = createDownloadsListener(downloads, identity);
    const base = { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content: "x" };
    expect(await deliver(listener, { ...base, namespace: "../x" })).toBe("ignored");
    expect(await deliver(listener, { ...base, url: "https://example.com/x" })).toBe("ignored");
    const page = { id: ID, url: "https://recnrun.com/" };
    expect(await deliver(listener, base, page)).toBe("ignored");
    expect(await deliver(listener, base, { id: "other", url: diagnostics.url })).toBe("ignored");
    expect(await deliver(listener, { type: "ping" })).toBe("ignored");
    expect(downloads.download).not.toHaveBeenCalled();
  });
});

describe("POC_DOWNLOAD_CANCEL and POC_DOWNLOAD_SEARCH", () => {
  test("cancels a download and answers with its item", async () => {
    const { downloads } = fakeDownloads();
    const listener = createDownloadsListener(downloads, identity);
    const base = { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content: "x", settle: false };
    await deliver(listener, base);
    expect(await deliver(listener, { type: "POC_DOWNLOAD_CANCEL", id: 1 })).toMatchObject({
      ok: true,
      result: { id: 1, state: "interrupted", error: "USER_CANCELED" },
    });
    expect(downloads.cancel).toHaveBeenCalledWith(1);
  });

  test("lists the history Chrome keeps, whole or for one id", async () => {
    const { downloads } = fakeDownloads({ settledAtStart: true });
    const listener = createDownloadsListener(downloads, identity);
    const base = { type: "POC_DOWNLOAD_PROBE", namespace: "lab", content: "x" };
    await deliver(listener, base);
    await deliver(listener, base);
    expect(await deliver(listener, { type: "POC_DOWNLOAD_SEARCH" })).toMatchObject({
      ok: true,
      result: { count: 2 },
    });
    expect(await deliver(listener, { type: "POC_DOWNLOAD_SEARCH", id: 2 })).toMatchObject({
      result: { count: 1, items: [{ id: 2 }] },
    });
  });
});

describe("downloadsWriter", () => {
  test("writes a rendezvous file by relative path, replacing it without asking", async () => {
    const { downloads } = fakeDownloads();
    const path = "RECnRun/poc/lab/peers/x/presence.json";
    expect(await downloadsWriter(downloads).write(path, '{"a":1}')).toBe(1);
    expect(downloads.download).toHaveBeenCalledWith({
      url: "data:application/json;charset=utf-8,%7B%22a%22%3A1%7D",
      filename: path,
      saveAs: false,
      conflictAction: "overwrite",
    });
  });

  test("a rewrite of a path waits until Chrome settled the last write to it, in any writer", async () => {
    const { downloads, finish } = fakeDownloads();
    const path = "RECnRun/poc/lab/peers/x/presence.json";
    const first = await downloadsWriter(downloads).write(path, "1");
    // Another writer over the same Downloads, as the bootstrap page's publication is.
    const second = downloadsWriter(downloads).write(path, "2");
    const other = await downloadsWriter(downloads).write("RECnRun/poc/lab/acks/x/t.json", "3");
    await vi.waitFor(() => expect(downloads.search).toHaveBeenCalled());
    expect(downloads.download.mock.calls.map(([{ filename }]) => filename)).toEqual([
      path,
      "RECnRun/poc/lab/acks/x/t.json",
    ]);
    finish(first, "complete");
    expect(await second).toBe(3);
    expect(other).toBe(2);
  });

  test("a rewrite goes ahead once the last write is gone from history or its wait ran out", async () => {
    vi.useFakeTimers();
    try {
      const { downloads } = fakeDownloads();
      const writer = downloadsWriter(downloads);
      const path = "RECnRun/poc/lab/peers/x/offer-y.json";
      await writer.write(path, "1");
      const second = writer.write(path, "2");
      await vi.advanceTimersByTimeAsync(9_999);
      expect(downloads.download).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await second).toBe(2);
      // An item erased from history has settled: its path is free at once.
      downloads.search.mockResolvedValue([]);
      const erased = "RECnRun/poc/lab/peers/x/answer-y.json";
      await writer.write(erased, "3");
      const again = writer.write(erased, "4");
      await vi.advanceTimersByTimeAsync(0);
      expect(await again).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("erases an item's file, if Chrome still has one, and then the item", async () => {
    const { downloads } = fakeDownloads();
    const eraser = {
      removeFile: vi.fn(async () => Promise.reject(new Error("Download file already deleted"))),
      erase: vi.fn(async () => [7]),
    };
    await downloadsWriter(downloads, eraser).erase(7);
    expect(eraser.removeFile).toHaveBeenCalledWith(7);
    expect(eraser.erase).toHaveBeenCalledWith({ id: 7 });
    await expect(downloadsWriter(downloads).erase(7)).rejects.toThrow("erases nothing");
  });
});

describe("startDownloadsPublisher", () => {
  test("adds one runtime.onMessage listener that ignores other messages", async () => {
    fakeBrowser.reset();
    const added = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");
    startDownloadsPublisher();
    expect(added).toHaveBeenCalledTimes(1);
    const [listener] = added.mock.calls[0] ?? [];
    expect(listener?.({ type: "ping" }, diagnostics, () => undefined)).toBe(false);
  });
});
