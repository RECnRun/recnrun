import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPocFileReadRelay } from "@/background/poc-file-read";
import { installReadFile } from "@/diagnostics/read-file";
import { startPocFileRead } from "@/offscreen/poc-file-read";
import { POC_READ_FILE, readFileUrl } from "@/p2p/file-url-read";
import type { WebApis } from "@/p2p/file-url-read";

const URL_ = "file:///tmp/e3-probe.txt";
const request = { type: POC_READ_FILE, url: URL_ };
const background = {
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/background.js"),
};
const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/diagnostics.html") };
const offscreen = {
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/offscreen.html"),
};
const contentScript = { id: fakeBrowser.runtime.id, url: "https://recnrun.com/" };
const stranger = { ...background, id: "another-extension" };

/** A fetch that answers `text`, recording the init it was given. */
function fakeFetch(text = "probe") {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(text, { status: 200 }));
}

/** An XMLHttpRequest that loads `text`, or errors when `text` is undefined. */
function fakeXhr(text: string | undefined) {
  return class {
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    url = "";
    open(_method: string, url: string) {
      this.url = url;
    }
    send() {
      if (text === undefined) return this.onerror?.();
      this.responseText = text;
      this.onload?.();
    }
  } as unknown as typeof XMLHttpRequest;
}

async function trigger(message: unknown, sender: object) {
  let reply: unknown;
  let done = () => {};
  const replied = new Promise<void>((resolve) => (done = resolve));
  const answer = (value: unknown) => {
    reply = value;
    done();
  };
  const handled: unknown[] = await fakeBrowser.runtime.onMessage.trigger(message, sender, answer);
  if (handled.includes(true)) await replied;
  return { handled, reply };
}

beforeEach(() => {
  fakeBrowser.reset();
});

// The Node projects share one worker, so a spy on fakeBrowser must not outlive its test.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readFileUrl", () => {
  test("reads with fetch and passes the cache mode", async () => {
    const fetch = fakeFetch("bytes");
    const result = await readFileUrl({ url: URL_, cache: "no-store" }, { fetch });
    expect(result).toEqual({ ok: true, status: 200, text: "bytes" });
    expect(fetch).toHaveBeenCalledWith(URL_, { cache: "no-store" });
  });

  test("names the error a failed fetch rejects with", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    const result = await readFileUrl({ url: URL_ }, { fetch });
    expect(result).toEqual({ ok: false, error: { name: "TypeError", message: "Failed to fetch" } });
  });

  test("reads with XMLHttpRequest when asked, and reports its error", async () => {
    const apis = (text: string | undefined): WebApis => ({
      fetch: fakeFetch(),
      XMLHttpRequest: fakeXhr(text),
    });
    expect(await readFileUrl({ url: URL_, api: "xhr" }, apis("xhr bytes"))).toEqual({
      ok: true,
      status: 0,
      text: "xhr bytes",
    });
    const failed = await readFileUrl({ url: URL_, api: "xhr" }, apis(undefined));
    expect(failed).toEqual({
      ok: false,
      error: { name: "NetworkError", message: "XMLHttpRequest failed" },
    });
    const missing = await readFileUrl({ url: URL_, api: "xhr" }, { fetch: fakeFetch() });
    expect(missing.ok).toBe(false);
  });

  test("turns a thrown non-error into a failure", async () => {
    const fetch = vi.fn(async () => Promise.reject("refused"));
    expect(await readFileUrl({ url: URL_ }, { fetch })).toEqual({
      ok: false,
      error: { name: "Error", message: "refused" },
    });
  });
});

describe("the offscreen handler", () => {
  test("answers the background with what it read", async () => {
    const fetch = fakeFetch("offscreen bytes");
    startPocFileRead({ apis: { fetch } });
    const { reply } = await trigger({ ...request, cache: "default" }, background);
    expect(reply).toEqual({ ok: true, status: 200, text: "offscreen bytes" });
    expect(fetch).toHaveBeenCalledWith(URL_, { cache: "default" });
  });

  test.each([
    ["a page", request, page],
    ["another extension", request, stranger],
    ["a URL that is not file://", { ...request, url: "https://example.com/" }, background],
    ["another message", { type: "POC_DOWNLOAD_PROBE" }, background],
  ])("ignores %s", async (_name, message, sender) => {
    const fetch = fakeFetch();
    startPocFileRead({ apis: { fetch } });
    const { handled, reply } = await trigger(message, sender);
    expect(handled).toEqual([false]);
    expect(reply).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the background relay", () => {
  test("creates the offscreen document, then forwards the page's request to it", async () => {
    const order: string[] = [];
    const ensure = vi.fn(async () => void order.push("ensure"));
    const send = vi.fn(async (message: unknown) => {
      order.push("send");
      expect(message).toEqual(request);
      return { ok: true, status: 200, text: "relayed" };
    });
    startPocFileReadRelay({ ensure, send });
    const { reply } = await trigger(request, page);
    expect(reply).toEqual({ ok: true, status: 200, text: "relayed" });
    expect(order).toEqual(["ensure", "send"]);
  });

  test("fails clearly when the offscreen document gives no answer or cannot start", async () => {
    startPocFileReadRelay({ ensure: async () => {}, send: async () => undefined });
    expect((await trigger(request, page)).reply).toEqual({
      ok: false,
      error: { name: "Error", message: "The offscreen document did not answer." },
    });
    fakeBrowser.reset();
    const ensure = async () => Promise.reject(new Error("Only a single offscreen document"));
    startPocFileReadRelay({ ensure, send: async () => undefined });
    expect((await trigger(request, page)).reply).toEqual({
      ok: false,
      error: { name: "Error", message: "Only a single offscreen document" },
    });
  });

  test.each([
    ["a content script", request, contentScript],
    ["the offscreen document", request, offscreen],
    ["another extension", request, { ...page, id: "another-extension" }],
    ["an invalid request", { ...request, cache: "only-if-cached" }, page],
  ])("refuses %s", async (_name, message, sender) => {
    const send = vi.fn(async () => ({ ok: true, status: 200, text: "" }));
    startPocFileReadRelay({ ensure: async () => {}, send });
    const { handled } = await trigger(message, sender);
    expect(handled).toEqual([false]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("window.__poc.readFile", () => {
  type Read = (url: string, options: unknown) => Promise<unknown>;
  const readFileOf = (target: { __poc?: Record<string, unknown> }) =>
    target.__poc?.readFile as Read;

  test("keeps what is already on window.__poc", () => {
    const probe = () => undefined;
    const target: { __poc?: Record<string, unknown> } = { __poc: { probe } };
    installReadFile(target, async () => undefined, { fetch: fakeFetch() });
    expect(target.__poc?.probe).toBe(probe);
    expect(typeof target.__poc?.readFile).toBe("function");
  });

  test("sends through runtime.sendMessage by default", async () => {
    const answer = { ok: true, status: 200, text: "sent" };
    const sent = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(answer as never);
    const target: { __poc?: Record<string, unknown> } = {};
    installReadFile(target, undefined, { fetch: fakeFetch() });
    const read = await readFileOf(target)(URL_, { via: "offscreen" });
    expect(read).toEqual(answer);
    expect(sent).toHaveBeenCalledWith(request);
  });

  test("reads in the page itself with fetch", async () => {
    const fetch = fakeFetch("page bytes");
    const send = vi.fn(async () => undefined);
    const target: { __poc?: Record<string, unknown> } = {};
    installReadFile(target, send, { fetch });
    const read = await readFileOf(target)(URL_, { via: "page", cache: "no-store" });
    expect(read).toEqual({ ok: true, status: 200, text: "page bytes" });
    expect(fetch).toHaveBeenCalledWith(URL_, { cache: "no-store" });
    expect(send).not.toHaveBeenCalled();
  });

  test("asks the offscreen document through the background", async () => {
    const fetch = fakeFetch();
    const send = vi.fn(async () => ({ ok: true, status: 200, text: "offscreen bytes" }));
    const target: { __poc?: Record<string, unknown> } = {};
    installReadFile(target, send, { fetch });
    const read = await readFileOf(target)(URL_, { via: "offscreen", api: "xhr" });
    expect(read).toEqual({ ok: true, status: 200, text: "offscreen bytes" });
    expect(send).toHaveBeenCalledWith({ ...request, api: "xhr" });
    expect(fetch).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(undefined as never);
    expect(await readFileOf(target)(URL_, { via: "offscreen" })).toEqual({
      ok: false,
      error: { name: "Error", message: "The background did not answer." },
    });
    send.mockRejectedValueOnce(new Error("Could not establish connection."));
    expect(await readFileOf(target)(URL_, { via: "offscreen" })).toEqual({
      ok: false,
      error: { name: "Error", message: "Could not establish connection." },
    });
  });

  test.each([
    ["a URL that is not file://", "https://example.com/", { via: "page" }],
    ["an unknown context", URL_, { via: "worker" }],
  ])("refuses %s without reading", async (_name, url, options) => {
    const fetch = fakeFetch();
    const send = vi.fn(async () => undefined);
    const target: { __poc?: Record<string, unknown> } = {};
    installReadFile(target, send, { fetch });
    const read = (await readFileOf(target)(url, options)) as { ok: boolean };
    expect(read.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
