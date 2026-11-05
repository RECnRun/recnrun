import { describe, expect, test, vi } from "vite-plus/test";
import {
  createPrepareListener,
  writePrepareRequest,
  writePrepareRetry,
} from "@/background/poc-prepare";
import type { PrepareDependencies } from "@/background/poc-prepare";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { operationPath } from "@/p2p/downloads-rendezvous";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const NOW = 1_700_000_000_000;
const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const choice = { operationId: OP, basesDir: "/Users/me/Bases", baseName: "base-v1", clones: 2 };

type Written = Parameters<DownloadsPort["download"]>[0];

function dependencies(overrides: Partial<PrepareDependencies> = {}) {
  const written: Written[] = [];
  const ids = new Set<string>();
  const deps: PrepareDependencies = {
    downloads: {
      download: vi.fn(async (options: Written) => written.push(options)),
      search: vi.fn(async ({ id = 0 }: { id?: number }) => [
        { id, filename: "", state: "complete" },
      ]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    masterProfileId: async () => ME,
    identity: async () => STATEMENT,
    namespace: async () => "lab-1",
    written: { has: async (id) => ids.has(id), add: async (id) => void ids.add(id) },
    now: () => NOW,
    ...overrides,
  };
  return { deps, written };
}

const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

describe("writePrepareRequest", () => {
  test("writes request.json under the operation, keys in the order the launcher reads", async () => {
    const { deps, written } = dependencies();
    await writePrepareRequest(deps, choice);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      filename: `RECnRun/poc/lab-1/ops/${OP}/request.json`,
      saveAs: false,
      conflictAction: "overwrite",
    });
    expect(contentOf(written[0]?.url ?? "")).toBe(
      JSON.stringify({
        operationId: OP,
        kind: "prepare-workers",
        basesDir: "/Users/me/Bases",
        baseName: "base-v1",
        clones: 2,
        namespace: "lab-1",
        masterProfileId: ME,
        masterIdentity: STATEMENT,
        createdAt: NOW,
      }),
    );
  });

  test("refuses a second write of the same operation", async () => {
    const { deps, written } = dependencies();
    await writePrepareRequest(deps, choice);
    await expect(writePrepareRequest(deps, choice)).rejects.toThrow(/already written/);
    expect(written).toHaveLength(1);
  });

  test("refuses a profile that is not the master and writes nothing", async () => {
    const { deps, written } = dependencies({ masterProfileId: async () => undefined });
    await expect(writePrepareRequest(deps, choice)).rejects.toThrow(/Only the master/);
    expect(written).toEqual([]);
  });

  test("refuses before the first presence", async () => {
    const { deps, written } = dependencies({ identity: async () => undefined });
    await expect(writePrepareRequest(deps, choice)).rejects.toThrow(/No presence/);
    expect(written).toEqual([]);
  });
});

describe("writePrepareRetry", () => {
  test("writes an empty retry file for an operation this profile wrote", async () => {
    const { deps, written } = dependencies();
    await writePrepareRequest(deps, choice);
    await writePrepareRetry(deps, OP);
    expect(written[1]?.filename).toBe(operationPath("lab-1", OP, "retry"));
    expect(contentOf(written[1]?.url ?? "")).toBe("");
  });

  test("refuses an operation it did not write, and a non-master", async () => {
    const { deps, written } = dependencies();
    await expect(writePrepareRetry(deps, OP)).rejects.toThrow(/not written/);
    const other = dependencies({ masterProfileId: async () => undefined });
    await expect(writePrepareRetry(other.deps, OP)).rejects.toThrow(/Only the master/);
    expect(written).toEqual([]);
  });
});

describe("createPrepareListener", () => {
  const own = { extensionId: "me", extensionUrl: "chrome-extension://me/" };
  const sender = { id: "me", url: "chrome-extension://me/dashboard.html" };
  const message = { type: "POC_PREPARE_WORKERS", op: "request", choice };

  test("answers its own page with ok once the request is written", async () => {
    const { deps, written } = dependencies();
    const reply = vi.fn();
    expect(createPrepareListener(deps, own)(message, sender, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(written).toHaveLength(1);
  });

  test("answers a refusal with its reason", async () => {
    const { deps } = dependencies({ masterProfileId: async () => undefined });
    const reply = vi.fn();
    createPrepareListener(deps, own)(message, sender, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("master") }),
    );
  });

  test.each([
    ["another extension", { id: "other", url: "chrome-extension://other/x.html" }, message],
    ["a content script", { id: "me", url: "https://example.com/" }, message],
    ["another message", sender, { type: "POC_LAUNCHER_ACK" }],
    ["a choice with extra keys", sender, { ...message, choice: { ...choice, extra: 1 } }],
    ["clones out of range", sender, { ...message, choice: { ...choice, clones: 9 } }],
    ["a basesDir with ..", sender, { ...message, choice: { ...choice, basesDir: "/a/../b" } }],
  ])("ignores %s", (_name, from, sent) => {
    const { deps, written } = dependencies();
    expect(createPrepareListener(deps, own)(sent, from, vi.fn())).toBe(false);
    expect(written).toEqual([]);
  });
});
