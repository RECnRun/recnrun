import { describe, expect, test, vi } from "vite-plus/test";
import { writePause } from "@/background/launcher-pause";
import type { PauseDependencies } from "@/background/launcher-pause";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const NOW = 1_700_000_000_000;

type Written = Parameters<DownloadsPort["download"]>[0];

function dependencies(overrides: Partial<PauseDependencies> = {}) {
  const written: Written[] = [];
  const deps: PauseDependencies = {
    downloads: {
      download: vi.fn(async (options: Written) => written.push(options)),
      search: vi.fn(async ({ id = 0 }: { id?: number }) => [
        { id, filename: "", state: "complete" },
      ]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    profileId: async () => ME,
    identity: async () => STATEMENT,
    namespace: async () => "lab",
    now: () => NOW,
    ...overrides,
  };
  return { deps, written };
}

const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));
const bytes = (reason: string) =>
  JSON.stringify({ profileId: ME, reason, identity: STATEMENT, createdAt: NOW });

describe("writePause", () => {
  test.each(["disconnect", "forget", "resumed"] as const)(
    "writes the %s statement with its keys in a fixed order, replacing an earlier one",
    async (reason) => {
      const { deps, written } = dependencies();
      await writePause(deps, reason);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ saveAs: false, conflictAction: "overwrite" });
      expect(contentOf(written[0]?.url ?? "")).toBe(bytes(reason));
    },
  );

  test("writes under the profile's own folder, in its namespace", async () => {
    const { deps, written } = dependencies({ namespace: async () => "e9-lab" });
    await writePause(deps, "disconnect");
    expect(written[0]?.filename).toBe(`RECnRun/poc/e9-lab/peers/${ME}/paused.json`);
  });

  test.each(["", "Lab", "a/b", "../x", "a".repeat(41)])(
    "writes nothing for the namespace %j",
    async (namespace) => {
      const { deps, written } = dependencies({ namespace: async () => namespace });
      await expect(writePause(deps, "disconnect")).rejects.toThrow();
      expect(written).toEqual([]);
    },
  );

  test("writes nothing for a profile id that is not a uuid", async () => {
    const { deps, written } = dependencies({ profileId: async () => "../x" });
    await expect(writePause(deps, "forget")).rejects.toThrow();
    expect(written).toEqual([]);
  });

  test("stamps the time of the write by default", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { deps, written } = dependencies({ now: undefined });
      await writePause(deps, "disconnect");
      expect(contentOf(written[0]?.url ?? "")).toBe(bytes("disconnect"));
    } finally {
      vi.useRealTimers();
    }
  });
});
