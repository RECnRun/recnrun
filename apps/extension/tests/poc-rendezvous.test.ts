import { describe, expect, test, vi } from "vite-plus/test";
import { pocDownloadsRendezvous } from "@/offscreen/poc-rendezvous";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import { ME, PEER } from "./fake-peer";

const BOOT = "99999999-9999-4999-8999-999999999999";
const ROOT = "/home/me/Downloads";
const REGISTRY_URL = `file://${ROOT}/RECnRun/poc/lab/registry.json`;

/** The background's side of the relay, recording each request. */
function background(root: string | null = ROOT, refuse?: string) {
  const ops: string[] = [];
  const send = vi.fn(async (message: unknown) => {
    const { op } = message as { op: string };
    ops.push(op);
    if (op === "write" && refuse) return { ok: false, error: refuse };
    if (op === "context") return { ok: true, result: { namespace: "lab", root } };
    if (op === "boot") return { ok: true, result: BOOT };
    return op === "write" ? { ok: true, result: 7 } : { ok: true };
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
    throw new TypeError("Failed to fetch");
  });
  const transport = pocDownloadsRendezvous({ send, apis: { fetch } })(ME);
  return { ops, send, fetch, transport };
}

const offer = {
  kind: "offer" as const,
  pairingId: "44444444-4444-4444-8444-444444444444",
  profileId: ME,
  to: PEER,
  expiresAt: Date.now() + PAIRING_TTL_MS,
  code: "RECNRUN-PAIR-1.code",
};

describe("pocDownloadsRendezvous", () => {
  test("reads through file:// with no-store, and asks for the root only until it knows it", async () => {
    const { ops, fetch, transport } = background();
    expect(await transport.look()).toEqual({ presences: [], signals: [] });
    expect(await transport.look()).toEqual({ presences: [], signals: [] });
    expect(ops).toEqual(["context"]);
    expect(fetch.mock.calls[0]).toEqual([REGISTRY_URL, { cache: "no-store" }]);
  });

  test("asks again while Chrome has not reported the root", async () => {
    const { ops, transport } = background(null);
    expect(await transport.available()).toBe(false);
    await expect(transport.look()).rejects.toThrow("The Downloads root is not known yet.");
    expect(ops).toEqual(["context", "context"]);
  });

  test("writes and erases through the background, stamping the boot it asks for", async () => {
    const { ops, send, transport } = background();
    await transport.publish(offer);
    await transport.clean();
    expect(ops).toEqual(["context", "boot", "write", "erase"]);
    const write = send.mock.calls[2]?.[0] as { path: string; text: string };
    expect(write.path).toBe(`RECnRun/poc/lab/peers/${ME}/offer-${PEER}.json`);
    expect(JSON.parse(write.text)).toMatchObject({ ...offer, boot: BOOT });
    expect(send.mock.calls[3]?.[0]).toEqual({ type: "POC_RENDEZVOUS", op: "erase", id: 7 });
  });

  test("fails a write the background refuses", async () => {
    const { transport } = background(ROOT, "Refusing it.");
    await expect(transport.publish(offer)).rejects.toThrow("Refusing it.");
  });
});
