import { describe, expect, test, vi } from "vite-plus/test";
import { createDownloadsPairing } from "@/background/downloads-pairing";
import type { DownloadsPairingDependencies } from "@/background/downloads-pairing";
import { startDownloadsPresence } from "@/background/downloads-presence";
import type { DownloadsPort } from "@/background/downloads-publisher";
import { FINGERPRINT, ME } from "./fake-peer";

function dependencies(overrides: Partial<DownloadsPairingDependencies> = {}) {
  const deps = {
    available: vi.fn(async () => true),
    start: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe("createDownloadsPairing", () => {
  test("starts the folder flow once the Downloads root is known, and again at each presence", async () => {
    const deps = dependencies();
    const pair = createDownloadsPairing(deps);
    await pair();
    await pair();
    expect(deps.start).toHaveBeenCalledTimes(2);
    expect(deps.log).not.toHaveBeenCalled();
  });

  test("starts nothing while Chrome has not told this profile its root", async () => {
    const deps = dependencies({ available: vi.fn(async () => false) });
    await createDownloadsPairing(deps)();
    expect(deps.available).toHaveBeenCalledOnce();
    expect(deps.start).not.toHaveBeenCalled();
  });

  test("runs one start at a time: a presence during a start joins it", async () => {
    let finish = () => {};
    const start = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValue(undefined);
    const deps = dependencies({ start });
    const pair = createDownloadsPairing(deps);
    const first = pair();
    const second = pair();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    finish();
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledOnce();
    await pair();
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("says why a start failed and tries again at the next presence", async () => {
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("The offscreen document did not answer."))
      .mockResolvedValue(undefined);
    const deps = dependencies({ start });
    const pair = createDownloadsPairing(deps);
    await expect(pair()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      "downloads pairing: The offscreen document did not answer.",
    );
    await pair();
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("says why it could not tell whether the root is known, and starts nothing", async () => {
    const deps = dependencies({ available: vi.fn(async () => Promise.reject(new Error("gone"))) });
    await createDownloadsPairing(deps)();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("downloads pairing: gone");
  });
});

describe("startDownloadsPresence and pairing", () => {
  /** A presence whose writes complete at once, or fail while `failing` is set. */
  function presence() {
    const state = { failing: false, written: 0 };
    const downloads: DownloadsPort = {
      download: async () => {
        if (state.failing) throw new Error("Invalid filename");
        return ++state.written;
      },
      search: async ({ id }) => [
        {
          id: id ?? 0,
          filename: `/home/me/Downloads/RECnRun/poc/lab/peers/${ME}/presence.json`,
          state: "complete",
        },
      ],
      cancel: async () => {},
      onChanged: { addListener: () => {}, removeListener: () => {} },
    };
    const published = vi.fn(async () => {});
    const started = startDownloadsPresence({
      downloads,
      identity: async () => ({ profileId: ME, displayName: "Laptop" }),
      fingerprint: async () => FINGERPRINT,
      namespace: async () => undefined,
      boot: async () => "99999999-9999-4999-8999-999999999999",
      root: { read: async () => null, write: async () => {} },
      log: () => {},
      published,
    });
    return { state, published, started };
  }

  test("runs after each presence written, the one on request included, never after a failed one", async () => {
    const { state, published, started } = presence();
    await vi.waitFor(() => expect(published).toHaveBeenCalledOnce());
    await started.publish();
    expect(published).toHaveBeenCalledTimes(2);
    state.failing = true;
    await expect(started.publish()).rejects.toThrow("Invalid filename");
    started.stop();
    expect(published).toHaveBeenCalledTimes(2);
  });
});
