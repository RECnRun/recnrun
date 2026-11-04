import { describe, expect, test, vi } from "vite-plus/test";
import { createAckListener, writeAck } from "@/background/launcher-requests";
import type { AckDependencies } from "@/background/launcher-requests";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const NOW = 1_700_000_000_000;
const BOOT = "99999999-9999-4999-8999-999999999999";
const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";

type Written = Parameters<DownloadsPort["download"]>[0];

function dependencies(overrides: Partial<AckDependencies> = {}) {
  const written: Written[] = [];
  const deps: AckDependencies = {
    downloads: {
      download: vi.fn(async (options: Written) => written.push(options)),
    },
    profileId: async () => ME,
    identity: () => STATEMENT,
    namespace: async () => "lab",
    boot: async () => BOOT,
    now: () => NOW,
    ...overrides,
  };
  return { deps, written };
}

const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));
const bytes = (token: string, boot: string) =>
  JSON.stringify({ token, profileId: ME, identity: STATEMENT, boot, createdAt: NOW });

describe("writeAck", () => {
  test("a fresh start acknowledges with the token as the boot, keys in a fixed order", async () => {
    const { deps, written } = dependencies({ boot: async () => TOKEN });
    await writeAck(deps, TOKEN);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ saveAs: false, conflictAction: "overwrite" });
    expect(contentOf(written[0]?.url ?? "")).toBe(bytes(TOKEN, TOKEN));
  });

  test("a running session acknowledges with its own boot, which the token does not replace", async () => {
    const { deps, written } = dependencies();
    await writeAck(deps, TOKEN);
    expect(contentOf(written[0]?.url ?? "")).toBe(bytes(TOKEN, BOOT));
  });

  test("writes under the profile's own folder and the attempt's token, in its namespace", async () => {
    const { deps, written } = dependencies({ namespace: async () => "e8-lab" });
    await writeAck(deps, TOKEN);
    expect(written[0]?.filename).toBe(`RECnRun/poc/e8-lab/acks/${ME}/${TOKEN}.json`);
  });

  test.each([
    "",
    "nope",
    TOKEN.toUpperCase(),
    `${TOKEN}/../x`,
    "0f8b6a3e-2c1d-1e5f-9a7b-1c2d3e4f5a6b",
  ])("writes nothing for the token %j", async (token) => {
    const { deps, written } = dependencies();
    await expect(writeAck(deps, token)).rejects.toThrow();
    expect(written).toEqual([]);
  });

  test("writes nothing before a presence carries an identity", async () => {
    const { deps, written } = dependencies({ identity: () => undefined });
    await expect(writeAck(deps, TOKEN)).rejects.toThrow("No presence has been published yet.");
    expect(written).toEqual([]);
  });

  test("stamps the time of the write by default", async () => {
    vi.useFakeTimers({ now: NOW });
    const { deps, written } = dependencies({ now: undefined });
    await writeAck(deps, TOKEN);
    vi.useRealTimers();
    expect(JSON.parse(contentOf(written[0]?.url ?? "")).createdAt).toBe(NOW);
  });
});

describe("createAckListener", () => {
  const own = { extensionId: "own", extensionUrl: "chrome-extension://own/" };
  const page = { id: "own", url: `chrome-extension://own/bootstrap.html#token=${TOKEN}` };
  const request = { type: "POC_LAUNCHER_ACK", token: TOKEN };

  test("acknowledges for the extension's own page and replies once it is written", async () => {
    const ack = vi.fn(async (_token: string) => {});
    const reply = vi.fn();
    expect(createAckListener(ack, own)(request, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(ack).toHaveBeenCalledWith(TOKEN);
  });

  test.each([
    ["another message", { type: "POC_PUBLISH_PRESENCE" }, page],
    ["an extra key", { ...request, boot: TOKEN }, page],
    ["a malformed token", { ...request, token: "nope" }, page],
    ["another extension", request, { ...page, id: "stranger" }],
    ["a web page", request, { id: "own", url: "https://recnrun.com/" }],
  ])("ignores %s", (_name, message, sender) => {
    const ack = vi.fn(async (_token: string) => {});
    expect(createAckListener(ack, own)(message, sender, vi.fn())).toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });

  test("replies with the error of a failed write", async () => {
    const ack = vi.fn(async (_token: string) => Promise.reject(new Error("Invalid filename")));
    const reply = vi.fn();
    createAckListener(ack, own)(request, page, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ ok: false, error: "Invalid filename" }),
    );
  });
});
