import { describe, expect, test, vi } from "vite-plus/test";
import { claimMaster, createAckListener, writeAck } from "@/background/launcher-requests";
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
      // Every write has settled, so a rewrite of the same path goes ahead at once.
      search: vi.fn(async ({ id = 0 }: { id?: number }) => [
        { id, filename: "", state: "complete" },
      ]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    profileId: async () => ME,
    identity: async () => STATEMENT,
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
    const { deps, written } = dependencies({ identity: async () => undefined });
    await expect(writeAck(deps, TOKEN)).rejects.toThrow("No presence has been published yet.");
    expect(written).toEqual([]);
  });

  test("a template ack has no identity and carries the template fields last", async () => {
    // A template holds no working key or certificate, so it states none even if a presence did.
    const { deps, written } = dependencies({ boot: async () => TOKEN });
    await writeAck(deps, TOKEN, { template: true, setting: "base-v1" });
    expect(contentOf(written[0]?.url ?? "")).toBe(
      `{"token":"${TOKEN}","profileId":"${ME}","boot":"${TOKEN}","createdAt":${NOW},"template":true,"setting":"base-v1"}`,
    );
  });

  test("a clone ack carries its identity, then the instance, the operation, and provisioned", async () => {
    const { deps, written } = dependencies({ boot: async () => TOKEN });
    const clone = { instanceId: ME, operationId: BOOT, provisioned: true } as const;
    await writeAck(deps, TOKEN, clone);
    expect(contentOf(written[0]?.url ?? "")).toBe(
      `${bytes(TOKEN, TOKEN).slice(0, -1)},"instanceId":"${ME}","operationId":"${BOOT}","provisioned":true}`,
    );
    await expect(writeAck(deps, TOKEN, { ...clone, operationId: "nope" })).rejects.toThrow();
    expect(written).toHaveLength(1);
  });

  test("writes nothing for a template setting outside the pattern", async () => {
    const { deps, written } = dependencies();
    await expect(writeAck(deps, TOKEN, { template: true, setting: "base-v" })).rejects.toThrow();
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

  test("hands the template fields of the request to the ack", async () => {
    const ack = vi.fn(async (_token: string, _template?: unknown) => {});
    const reply = vi.fn();
    const template = { template: true, setting: "base-v1" };
    expect(createAckListener(ack, own)({ ...request, ...template }, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(ack).toHaveBeenCalledWith(TOKEN, template);
  });

  test("hands a master request to the ack as its third argument", async () => {
    const ack = vi.fn(async (_token: string, _template?: unknown, _master?: boolean) => {});
    const reply = vi.fn();
    expect(createAckListener(ack, own)({ ...request, master: true }, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(ack).toHaveBeenCalledWith(TOKEN, undefined, true);
  });

  test.each([
    [
      "a master request from another extension",
      { ...request, master: true },
      { ...page, id: "stranger" },
    ],
    [
      "a master request from a web page",
      { ...request, master: true },
      { id: "own", url: "https://recnrun.com/" },
    ],
    [
      "a master flag with a template",
      { ...request, master: true, template: true, setting: "base-v1" },
      page,
    ],
    ["a false master flag", { ...request, master: false }, page],
    ["another message", { type: "POC_PUBLISH_PRESENCE" }, page],
    ["an extra key", { ...request, boot: TOKEN }, page],
    ["a malformed token", { ...request, token: "nope" }, page],
    ["a template flag without a setting", { ...request, template: true }, page],
    ["a setting without the template flag", { ...request, setting: "base-v1" }, page],
    ["a setting outside the pattern", { ...request, template: true, setting: "x" }, page],
    ["a false template flag", { ...request, template: false, setting: "base-v1" }, page],
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

describe("claimMaster", () => {
  const profile = { profileId: async () => ME, identity: async () => STATEMENT };

  test("records this profile as the master with the key of its presence, once", async () => {
    const becomeMaster = vi.fn(async (_self: unknown) => ({ ok: true as const }));
    await claimMaster({ becomeMaster }, profile);
    expect(becomeMaster).toHaveBeenCalledWith({ profileId: ME, identity: STATEMENT.key });
  });

  test("refuses before a presence carries an identity", async () => {
    const becomeMaster = vi.fn(async (_self: unknown) => ({ ok: true as const }));
    await expect(
      claimMaster({ becomeMaster }, { ...profile, identity: async () => undefined }),
    ).rejects.toThrow("No presence has been published yet.");
    expect(becomeMaster).not.toHaveBeenCalled();
  });

  test.each(["template", "bound", "master-differs", "malformed", "store-failed"])(
    "refuses when the role outcome is %s",
    async (reason) => {
      const becomeMaster = vi.fn(async (_self: unknown) => ({ ok: false as const, reason }));
      await expect(claimMaster({ becomeMaster }, profile)).rejects.toThrow(reason);
    },
  );
});
