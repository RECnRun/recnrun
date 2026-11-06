import { describe, expect, test, vi } from "vite-plus/test";
import { createCloneControlListener, writeCloneControl } from "@/background/poc-clone-control";
import type { PrepareDependencies } from "@/background/poc-prepare";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const NOW = 1_700_000_000_000;
const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W1 = "11111111-1111-4111-8111-111111111111";
const choice = { requestId: REQ, action: "reopen-headless", instanceId: W1 } as const;

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

describe("writeCloneControl", () => {
  test("writes request.json under control/, keys in the order the launcher reads", async () => {
    const { deps, written } = dependencies();
    await writeCloneControl(deps, choice);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      filename: `RECnRun/poc/lab-1/control/${REQ}/request.json`,
      saveAs: false,
      conflictAction: "overwrite",
    });
    expect(contentOf(written[0]?.url ?? "")).toBe(
      JSON.stringify({
        requestId: REQ,
        kind: "clone-control",
        action: "reopen-headless",
        instanceId: W1,
        namespace: "lab-1",
        masterProfileId: ME,
        masterIdentity: STATEMENT,
        createdAt: NOW,
      }),
    );
  });

  test("refuses a second write of the same request", async () => {
    const { deps, written } = dependencies();
    await writeCloneControl(deps, choice);
    await expect(writeCloneControl(deps, choice)).rejects.toThrow(/already written/);
    expect(written).toHaveLength(1);
  });

  test("refuses a profile that is not the master and writes nothing", async () => {
    const { deps, written } = dependencies({ masterProfileId: async () => undefined });
    await expect(writeCloneControl(deps, choice)).rejects.toThrow(/Only the master/);
    expect(written).toEqual([]);
  });

  test("refuses before the first presence", async () => {
    const { deps, written } = dependencies({ identity: async () => undefined });
    await expect(writeCloneControl(deps, choice)).rejects.toThrow(/No presence/);
    expect(written).toEqual([]);
  });
});

describe("createCloneControlListener", () => {
  const own = { extensionId: "me", extensionUrl: "chrome-extension://me/" };
  const sender = { id: "me", url: "chrome-extension://me/dashboard.html" };
  const message = { type: "POC_CLONE_CONTROL", choice };

  test("answers its own page with ok once the request is written", async () => {
    const { deps, written } = dependencies();
    const reply = vi.fn();
    expect(createCloneControlListener(deps, own)(message, sender, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(written).toHaveLength(1);
  });

  test("answers a refusal with its reason", async () => {
    const { deps } = dependencies({ masterProfileId: async () => undefined });
    const reply = vi.fn();
    createCloneControlListener(deps, own)(message, sender, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("master") }),
    );
  });

  test.each([
    ["another extension", { id: "other", url: "chrome-extension://other/x.html" }, message],
    ["a content script", { id: "me", url: "https://example.com/" }, message],
    ["another message", sender, { type: "POC_PREPARE_WORKERS" }],
    ["an unknown action", sender, { ...message, choice: { ...choice, action: "kill" } }],
    ["extra keys", sender, { ...message, choice: { ...choice, extra: 1 } }],
  ])("ignores %s", (_name, from, sent) => {
    const { deps, written } = dependencies();
    expect(createCloneControlListener(deps, own)(sent, from, vi.fn())).toBe(false);
    expect(written).toEqual([]);
  });
});
