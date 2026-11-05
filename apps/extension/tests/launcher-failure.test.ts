import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  boundedError,
  createFailureListener,
  writeFailureAck,
} from "@/background/launcher-requests";
import type { FailureDependencies } from "@/background/launcher-requests";
import { offscreenFingerprint } from "@/background/link";
import { pocFingerprintRequest } from "@/messaging/poc-fingerprint";
import { bounded } from "@/p2p/bounded";
import { ME, answering } from "./fake-peer";

const NOW = 1_700_000_000_000;
const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

function dependencies() {
  const written: Array<{ url: string; filename: string }> = [];
  const deps: FailureDependencies = {
    downloads: {
      download: vi.fn(async (options: { url: string; filename: string }) => written.push(options)),
      search: vi.fn(async ({ id = 0 }: { id?: number }) => [
        { id, filename: "", state: "complete" },
      ]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    profileId: async () => ME,
    namespace: async () => "lab",
    now: () => NOW,
  };
  return { deps, written };
}

describe("writeFailureAck", () => {
  test("writes the failure at the ack path of the token, with no presence or identity", async () => {
    const { deps, written } = dependencies();
    await writeFailureAck(deps, TOKEN, "publish", "The offscreen document did not answer.");
    expect(written[0]?.filename).toBe(`RECnRun/poc/lab/acks/${ME}/${TOKEN}.json`);
    expect(contentOf(written[0]?.url ?? "")).toBe(
      `{"token":"${TOKEN}","profileId":"${ME}","failedStep":"publish","error":"The offscreen document did not answer.","createdAt":${NOW}}`,
    );
  });

  test("bounds the error to the alphabet and length open.sh reads", async () => {
    const { deps, written } = dependencies();
    await writeFailureAck(deps, TOKEN, "ack", `bad "quote" \\ $(id)\n${"x".repeat(500)}`);
    const { error } = JSON.parse(contentOf(written[0]?.url ?? ""));
    expect(error).toMatch(/^[A-Za-z0-9 .,:;()_/=-]{1,200}$/);
    expect(error.startsWith("bad quote (id) xxx")).toBe(true);
  });

  test("writes nothing for a token that is no v4 uuid", async () => {
    const { deps, written } = dependencies();
    await expect(writeFailureAck(deps, "nope", "ack", "x")).rejects.toThrow();
    expect(written).toEqual([]);
  });

  test("stamps the time of the write by default", async () => {
    vi.useFakeTimers({ now: NOW });
    const { deps, written } = dependencies();
    await writeFailureAck({ ...deps, now: undefined }, TOKEN, "adopt", "x");
    vi.useRealTimers();
    expect(JSON.parse(contentOf(written[0]?.url ?? "")).createdAt).toBe(NOW);
  });

  test("says unknown error when nothing of the text survives", () => {
    expect(boundedError("\n\t$$$")).toBe("unknown error");
  });
});

describe("createFailureListener", () => {
  const own = { extensionId: "own", extensionUrl: "chrome-extension://own/" };
  const page = { id: "own", url: "chrome-extension://own/bootstrap.html" };
  const request = { type: "POC_LAUNCHER_FAILURE", token: TOKEN, step: "publish", error: "stalled" };

  test("writes the failure for the extension's own page and replies once it is written", async () => {
    const fail = vi.fn(async () => {});
    const reply = vi.fn();
    expect(createFailureListener(fail, own)(request, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(fail).toHaveBeenCalledWith(TOKEN, "publish", "stalled");
  });

  test("replies with the error when the write fails", async () => {
    const reply = vi.fn();
    createFailureListener(() => Promise.reject(new Error("disk")), own)(request, page, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: "disk" }));
  });

  test.each([
    ["another sender", request, { id: "other", url: page.url }],
    ["an unknown step", { ...request, step: "launch" }, page],
    ["an extra key", { ...request, extra: 1 }, page],
    ["another message", { type: "POC_LAUNCHER_ACK", token: TOKEN }, page],
  ])("ignores %s", (_title, message, sender) => {
    const fail = vi.fn(async () => {});
    expect(createFailureListener(fail, own)(message, sender, vi.fn())).toBe(false);
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("bounded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("passes the result of work that settles in time and leaves no timer", async () => {
    await expect(bounded(Promise.resolve(7), 1000, "Work")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rejects with the step and the bound when the work stalls", async () => {
    const stalled = bounded(new Promise(() => {}), 1500, "Work");
    const rejected = expect(stalled).rejects.toThrow("Work did not finish within 1.5 s.");
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });
});

describe("offscreenFingerprint bounds", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("a stalled offscreen document is closed and the error names the bound", async () => {
    vi.spyOn(fakeBrowser.runtime, "getContexts").mockImplementation(answering(() => [{}]));
    const close = vi.spyOn(fakeBrowser.offscreen, "closeDocument").mockResolvedValue(undefined);
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockImplementation(() => new Promise(() => {}) as never);
    const asked = expect(offscreenFingerprint()).rejects.toThrow(
      "The offscreen document did not finish within 4 s.",
    );
    await vi.advanceTimersByTimeAsync(4000);
    await asked;
    expect(send).toHaveBeenCalledWith(pocFingerprintRequest());
    expect(close).toHaveBeenCalledTimes(1);
  });
});
