import { describe, expect, test, vi } from "vite-plus/test";
import { startDownloadsPresence } from "@/background/downloads-presence";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

// Signed once: a real signature takes longer than the fake timers these tests advance.
const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });

type Written = Parameters<DownloadsPort["download"]>[0];

/** Starts the presence for a profile whose stored name is `displayName`, and returns what it wrote. */
async function publishedAs(displayName: string) {
  const written: Written[] = [];
  const log = vi.fn();
  const downloads = {
    download: vi.fn(async (options: Written) => written.push(options)),
    search: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } satisfies DownloadsPort;
  const presence = startDownloadsPresence({
    downloads,
    identity: async () => ({ profileId: ME, displayName }),
    fingerprint: async () => FINGERPRINT,
    sign: async () => STATEMENT,
    namespace: async () => undefined,
    boot: async () => "99999999-9999-4999-8999-999999999999",
    root: { read: async () => "/home/me/Downloads", write: async () => {} },
    log,
  });
  // The start publishes once at once; the interval never fires before stop.
  await vi.waitFor(() => expect(written).toHaveLength(1));
  presence.stop();
  const url = written.at(-1)?.url ?? "";
  const registration: unknown = JSON.parse(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
  return { registration, log };
}

describe("the display name a presence publishes", () => {
  test("is the stored name when the catalog lists it", async () => {
    const { registration, log } = await publishedAs("José's Mac");
    expect(registration).toMatchObject({ displayName: "José's Mac" });
    expect(log).not.toHaveBeenCalled();
  });

  test.each(['My "Mac"', "é".repeat(40), "Desk "])(
    "is the default name, logged once, when the stored %j does not fit the catalog",
    async (stored) => {
      const { registration, log } = await publishedAs(stored);
      expect(registration).toMatchObject({ displayName: "Profile 1111" });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^presence: .*Profile 1111/));
    },
  );
});
