import { describe, expect, test, vi } from "vite-plus/test";
import { installReadRegistry, readOwnRegistry } from "@/diagnostics/read-registry";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import { FINGERPRINT, ME, PEER } from "./fake-peer";

const NOW = 1_700_000_000_000;
const ROOT = "/home/me/Downloads";
const BOOT = "44444444-4444-4444-8444-444444444444";

const peer = (profileId: string) => ({
  profileId,
  displayName: "Desk",
  fingerprint: FINGERPRINT,
  root: "r1",
  lastSeenAt: NOW - 500,
  expiresAt: NOW + PRESENCE_TTL_MS,
  boot: BOOT,
});

const registry = (namespace = "lab", extra: Record<string, unknown> = {}) => ({
  version: 1,
  namespace,
  writtenAt: NOW - 1000,
  launcher: { boot: BOOT },
  peers: { [ME]: { ...peer(ME), ...extra }, [PEER]: peer(PEER) },
});

function dependencies(text: string | Error, stored?: unknown, root = ROOT) {
  const fetcher = vi.fn(async (_url: string) =>
    text instanceof Error ? Promise.reject(text) : new Response(text),
  );
  const deps = {
    root: async () => root,
    namespace: async () => stored,
    fetcher: fetcher as unknown as typeof fetch,
    now: () => NOW,
  };
  return { deps, fetcher };
}

describe("readOwnRegistry", () => {
  test("reads registry.json under the learned root and its namespace, and lists the peers", async () => {
    const { deps, fetcher } = dependencies(JSON.stringify(registry()));
    expect(await readOwnRegistry(deps)).toEqual({
      reason: "fresh",
      namespace: "lab",
      peers: [peer(ME), peer(PEER)],
    });
    expect(fetcher).toHaveBeenCalledWith("file:///home/me/Downloads/RECnRun/poc/lab/registry.json");
  });

  test("joins the stored namespace, and the default when the stored one is not a namespace", async () => {
    const custom = dependencies(JSON.stringify(registry("e4-common")), "e4-common");
    expect(await readOwnRegistry(custom.deps)).toMatchObject({ namespace: "e4-common" });
    expect(custom.fetcher).toHaveBeenCalledWith(
      "file:///home/me/Downloads/RECnRun/poc/e4-common/registry.json",
    );
    const invalid = dependencies(JSON.stringify(registry()), "../escape");
    expect(await readOwnRegistry(invalid.deps)).toMatchObject({
      namespace: "lab",
      reason: "fresh",
    });
  });

  test("reads Windows roots through a file URL with forward slashes", async () => {
    const { deps, fetcher } = dependencies(
      JSON.stringify(registry()),
      undefined,
      "C:\\Users\\me\\Downloads",
    );
    await readOwnRegistry(deps);
    expect(fetcher).toHaveBeenCalledWith(
      "file:///C:/Users/me/Downloads/RECnRun/poc/lab/registry.json",
    );
  });

  test("lists no peer from a catalog of another namespace, one with a path, or none", async () => {
    const foreign = dependencies(JSON.stringify(registry("other")));
    expect(await readOwnRegistry(foreign.deps)).toEqual({
      reason: "other-namespace",
      namespace: "lab",
      peers: [],
    });
    const withPath = dependencies(JSON.stringify(registry("lab", { path: "/home/me" })));
    expect(await readOwnRegistry(withPath.deps)).toEqual({
      reason: "invalid",
      namespace: "lab",
      peers: [],
    });
    const unreadable = dependencies(new TypeError("Failed to fetch"));
    expect(await readOwnRegistry(unreadable.deps)).toEqual({
      reason: "absent",
      namespace: "lab",
      peers: [],
    });
  });

  test("reads nothing before this profile has learned its Downloads root", async () => {
    const { deps, fetcher } = dependencies("{}");
    expect(await readOwnRegistry({ ...deps, root: async () => null })).toEqual({
      reason: "no-root",
      namespace: "lab",
      peers: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("installReadRegistry", () => {
  test("adds readRegistry to window.__poc and keeps what is there", async () => {
    const { deps } = dependencies(JSON.stringify(registry()));
    const page: { __poc?: Record<string, unknown> } = { __poc: { readFile: "kept" } };
    installReadRegistry(page, deps);
    const read = page.__poc?.readRegistry as () => Promise<{ peers: unknown[] }>;
    expect(page.__poc?.readFile).toBe("kept");
    expect((await read()).peers).toHaveLength(2);
  });
});
