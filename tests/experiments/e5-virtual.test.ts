import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { namespaceFolder } from "./fixtures/e4-launcher.ts";
import { signalWrites } from "./fixtures/e5-observe.ts";
import { virtualIn, withGroup } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import { LOWEST_ID, decodeCode, virtualPeer } from "./fixtures/e5-virtual.ts";
import { signedBytes } from "./fixtures/identity-statement.ts";
import type { IdentityStatement } from "./fixtures/identity-statement.ts";

vi.mock("../browser/fixtures/downloads-profiles.ts", () => ({
  createDownloadsGroup: async () => ({ downloads: folder, dispose: async () => undefined }),
}));

// E5's virtual peer (fixtures/e5-virtual.ts): its bytes, and no write once its sample ended.
const SDP = "v=0\r\na=fingerprint:sha-256 ab:cd:ef\r\n";
const page = { evaluate: async () => SDP } as unknown as Page;
let folder = "";

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "recnrun-e5-virtual-"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(folder, { recursive: true, force: true });
});

/** Whether `statement` is its key's valid signature that `fingerprint` is `profileId`'s. */
async function verifies(statement: IdentityStatement, profileId: string, fingerprint: string) {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const raw = Buffer.from(statement.key, "base64url");
  const key = await crypto.subtle.importKey("raw", raw, algorithm, false, ["verify"]);
  const signature = Buffer.from(statement.signature, "base64url");
  const bytes = signedBytes(profileId, fingerprint, statement.signedAt);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, bytes);
}

const presenceText = () =>
  readFile(join(namespaceFolder(folder), "peers", LOWEST_ID, "presence.json"), "utf8");

describe("E5 virtual peer", () => {
  test("writes its presence in the extension's key order, with its certificate", async () => {
    const peer = await virtualPeer(page, folder);
    await peer.announce();
    peer.stop();
    const presence = JSON.parse(await presenceText()) as Record<string, unknown>;
    expect(Object.keys(presence)).toEqual([
      "profileId",
      "displayName",
      "fingerprint",
      "identity",
      "createdAt",
      "expiresAt",
      "namespace",
      "boot",
    ]);
    expect(presence).toMatchObject({
      profileId: LOWEST_ID,
      fingerprint: "AB:CD:EF",
      boot: peer.boot,
    });
  });

  test("signs its certificate with its own key, in its presence and in its codes", async () => {
    const peer = await virtualPeer(page, folder);
    const offer = await peer.signal("offer", LOWEST_ID);
    peer.stop();
    expect(peer.presence().identity).toEqual(peer.identity);
    expect(decodeCode(offer.code).identity).toEqual(peer.identity);
    expect(await verifies(peer.identity, LOWEST_ID, "AB:CD:EF")).toBe(true);
    expect(await verifies(peer.identity, LOWEST_ID, "AB:CD:EE")).toBe(false);
    const other = await virtualPeer(page, folder);
    expect(other.identity.key).not.toBe(peer.identity.key);
  });

  test("keeps no refresh once stopped during its first write", async () => {
    const peer = await virtualPeer(page, folder);
    const written = peer.announce();
    peer.stop();
    await written;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stamps each signal with its boot and a rising sequence", async () => {
    const peer = await virtualPeer(page, folder);
    const first = await peer.signal("offer", LOWEST_ID);
    const second = await peer.signal("offer", LOWEST_ID);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect([first.boot, second.boot]).toEqual([peer.boot, peer.boot]);
  });

  test("stops with its sample's group, so no refresh reaches the next sample", async () => {
    const host = { context: { newPage: async () => page } } as unknown as DownloadsProfile;
    const environment = { platform: () => ({}) } as unknown as E5Environment;
    await withGroup(environment, async (group) => {
      await (await virtualIn(group, host, LOWEST_ID)).announce();
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("E5 signal writes", () => {
  test("reads each signal's pairing from the data: URL Chrome's history keeps, and nothing else", async () => {
    const data = (body: object) =>
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(body))}`;
    const items = [
      {
        filename: "/d/RECnRun/poc/lab/peers/a/answer-b.json",
        url: data({ pairingId: "p1" }),
        startTime: "2026-11-04T00:00:01.000Z",
        endTime: "2026-11-04T00:00:01.005Z",
      },
      {
        filename: "/d/RECnRun/poc/lab/peers/a/presence.json",
        url: data({ pairingId: "p2" }),
        startTime: "2026-11-04T00:00:02.000Z",
      },
      {
        filename: "/d/x/offer-b.json",
        url: "data:,not json",
        startTime: "2026-11-04T00:00:03.000Z",
      },
    ];
    const profile = {
      serviceWorker: { evaluate: async () => items },
    } as unknown as DownloadsProfile;
    expect(await signalWrites(profile)).toEqual([
      {
        name: "answer-b.json",
        pairingId: "p1",
        startedAt: Date.parse("2026-11-04T00:00:01.000Z"),
        endedAt: Date.parse("2026-11-04T00:00:01.005Z"),
      },
    ]);
  });
});
