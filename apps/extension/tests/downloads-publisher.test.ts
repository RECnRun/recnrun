import { describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createDownloadsListener, startDownloadsPublisher } from "@/background/downloads-publisher";
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
