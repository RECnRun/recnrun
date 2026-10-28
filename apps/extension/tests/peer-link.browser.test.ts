import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { certificateFingerprint } from "@/p2p/certificate-store";
import { fingerprintOf } from "@/p2p/pairing-code";
import { createPeerLink } from "@/p2p/peer-link";
import type { PeerLink } from "@/p2p/peer-link";

const CONNECT_MS = 15_000;
const links: PeerLink[] = [];
const P256: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

/** A link whose frames and state changes are recorded. */
async function side(withCertificate = true) {
  const frames: string[] = [];
  const states: string[] = [];
  const certificate = withCertificate
    ? await RTCPeerConnection.generateCertificate(P256)
    : undefined;
  const link = createPeerLink(
    { onFrame: (frame) => frames.push(frame), onState: (state) => states.push(state) },
    { certificate },
  );
  links.push(link);
  return { link, frames, states, certificate };
}

type Side = Awaited<ReturnType<typeof side>>;

/** The pairing as the two profiles run it: one offer, one answer, no candidate after either. */
async function pair(offerer: Side, answerer: Side) {
  const offer = await offerer.link.createOffer();
  const answer = await answerer.link.acceptOffer(offer);
  await offerer.link.acceptAnswer(answer);
  await vi.waitFor(
    () => {
      expect(offerer.link.state()).toBe("connected");
      expect(answerer.link.state()).toBe("connected");
    },
    { timeout: CONNECT_MS },
  );
  return { offer, answer };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const link of links.splice(0)) link.close();
});

describe("a pairing", () => {
  test("connects two links over host candidates and carries frames both ways", async () => {
    const [alice, bob] = [await side(), await side()];
    const { offer, answer } = await pair(alice, bob);
    // Non-trickle: each SDP already holds its candidates, and no STUN server adds others.
    for (const sdp of [offer, answer]) {
      expect(sdp).toMatch(/^a=candidate:.* typ host/m);
      expect(sdp).not.toMatch(/ typ (srflx|relay)/);
    }
    expect(alice.link.send("hello bob")).toBe(true);
    expect(bob.link.send("hello alice")).toBe(true);
    await vi.waitFor(() => {
      expect(bob.frames).toEqual(["hello bob"]);
      expect(alice.frames).toEqual(["hello alice"]);
    });
    expect(alice.states).toEqual(["connecting", "connected"]);
    expect(bob.states).toEqual(["connecting", "connected"]);
  });

  test("tells each side the other's certificate fingerprint", async () => {
    const [alice, bob] = [await side(), await side()];
    expect(alice.link.remoteFingerprint()).toBeUndefined();
    const { offer } = await pair(alice, bob);
    if (!alice.certificate || !bob.certificate) throw new Error("Both sides need certificates.");
    expect(fingerprintOf(offer)).toBe(certificateFingerprint(alice.certificate));
    expect(alice.link.remoteFingerprint()).toBe(certificateFingerprint(bob.certificate));
    expect(bob.link.remoteFingerprint()).toBe(certificateFingerprint(alice.certificate));
  });

  test("works with a certificate Chrome generates for the connection", async () => {
    const [alice, bob] = [await side(false), await side(false)];
    await pair(alice, bob);
    expect(alice.link.remoteFingerprint()).toMatch(/^[0-9A-F:]+$/);
  });

  test("logs candidate types and states, never an address", async () => {
    const [alice, bob] = [await side(), await side()];
    await pair(alice, bob);
    const log = alice.link.diagnostics();
    expect(log[0]).toMatch(/^\+\d+ms link connecting$/);
    expect(log).toContainEqual(expect.stringMatching(/ candidate host( \(mDNS\))? udp$/));
    expect(log).toContainEqual(expect.stringMatching(/ gathering complete$/));
    expect(log).toContainEqual(expect.stringMatching(/ link connected$/));
    expect(log.join("\n")).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f-]{36}\.local/);
  });
});

describe("closing", () => {
  test("disconnects both sides and stops sending", async () => {
    const [alice, bob] = [await side(), await side()];
    await pair(alice, bob);
    alice.link.close();
    expect(alice.link.state()).toBe("disconnected");
    expect(alice.link.send("late")).toBe(false);
    await vi.waitFor(() => expect(bob.link.state()).toBe("disconnected"), { timeout: CONNECT_MS });
    expect(bob.link.send("late")).toBe(false);
  });

  test("leaves a link that never connected idle", async () => {
    const { link, states } = await side();
    link.close();
    expect(link.state()).toBe("idle");
    expect(states).toEqual([]);
    expect(link.send("nobody")).toBe(false);
  });

  test("a new offer replaces the connection without reporting the old one's end", async () => {
    const [alice, bob] = [await side(), await side()];
    await pair(alice, bob);
    await alice.link.createOffer();
    await vi.waitFor(() => expect(bob.link.state()).toBe("disconnected"), { timeout: CONNECT_MS });
    expect(alice.states).toEqual(["connecting", "connected", "connecting"]);
    expect(alice.link.send("old channel")).toBe(false);
  });
});

describe("failures", () => {
  test("refuses an answer before an offer", async () => {
    const { link, states } = await side();
    await expect(link.acceptAnswer("v=0\r\n")).rejects.toThrow("Create an offer first.");
    expect(states).toEqual(["failed"]);
    expect(link.diagnostics()).toContainEqual(expect.stringMatching(/ error Error$/));
  });

  test("refuses an answer on the side that answered", async () => {
    const [alice, bob] = [await side(), await side()];
    await bob.link.acceptOffer(await alice.link.createOffer());
    await expect(bob.link.acceptAnswer("v=0\r\n")).rejects.toThrow("Create an offer first.");
    expect(bob.states).toEqual(["connecting", "failed"]);
  });

  test("fails on an offer that is not SDP, naming only the error", async () => {
    const { link, states } = await side();
    const refused = await link.acceptOffer("not sdp").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DOMException);
    expect(states).toEqual(["connecting", "failed"]);
    const [error] = link.diagnostics().filter((entry) => entry.includes(" error "));
    expect(error).toMatch(/ error \w+Error$/);
  });

  test("keeps only the last 200 diagnostics", async () => {
    const { link } = await side();
    for (let attempt = 0; attempt < 205; attempt += 1) {
      await link.acceptAnswer("v=0\r\n").catch(() => undefined);
    }
    const log = link.diagnostics();
    expect(log).toHaveLength(200);
    expect(log.every((entry) => entry.endsWith(" error Error"))).toBe(true);
  });

  test("returns what was gathered when gathering stalls", async () => {
    vi.spyOn(RTCPeerConnection.prototype, "iceGatheringState", "get").mockReturnValue("gathering");
    const link = createPeerLink({ onFrame: () => {}, onState: () => {} }, { gatherTimeoutMs: 50 });
    links.push(link);
    expect(await link.createOffer()).toMatch(/^v=0\r\n/);
  });
});
