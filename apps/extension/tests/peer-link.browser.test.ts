import { expect, test, vi } from "vite-plus/test";
import { runLinkCommand } from "@/offscreen/start";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";
import { createPeerLink, describeCandidate } from "@/p2p/peer-link";
import type { LinkState } from "@/p2p/peer-link";

function endpoint(certificate?: RTCCertificate) {
  const frames: string[] = [];
  const states: LinkState[] = [];
  const link = createPeerLink(
    { onFrame: (frame) => frames.push(frame), onState: (state) => states.push(state) },
    { certificate },
  );
  return { link, frames, states };
}

const generated = () =>
  RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" } as EcKeyGenParams);

async function paired() {
  const [first, second] = await Promise.all([generated(), generated()]);
  const a = endpoint(first);
  const b = endpoint(second);
  const offer = await a.link.createOffer();
  const answer = await b.link.acceptOffer(offer);
  await a.link.acceptAnswer(answer);
  await vi.waitFor(() => {
    expect(a.link.state()).toBe("connected");
    expect(b.link.state()).toBe("connected");
  });
  return { a, b, offer, first, second };
}

test("connects two links with no ICE server, each pinned to the other's certificate", async () => {
  const { a, b, offer, first, second } = await paired();
  // The SDP carries every candidate up front, and none comes from a STUN or TURN server.
  expect(offer).toMatch(/a=candidate:.* typ host/);
  expect(offer).not.toMatch(/typ (srflx|relay)/);
  expect(a.link.remoteFingerprint()).toBe(certificateFingerprint(second));
  expect(b.link.remoteFingerprint()).toBe(certificateFingerprint(first));
  expect(a.link.localFingerprint()).toBe(certificateFingerprint(first));

  expect(a.link.send("ping")).toBe(true);
  expect(b.link.send("pong")).toBe(true);
  await vi.waitFor(() => {
    expect(b.frames).toEqual(["ping"]);
    expect(a.frames).toEqual(["pong"]);
  });
  a.link.close();
  b.link.close();
});

test("tells the other side when one side closes", async () => {
  const { a, b } = await paired();
  a.link.close();
  expect(a.link.state()).toBe("disconnected");
  expect(a.link.send("late")).toBe(false);
  await vi.waitFor(() => expect(b.link.state()).toBe("disconnected"));
  b.link.close();
});

test("keeps diagnostics free of addresses", async () => {
  const { a, b } = await paired();
  const log = a.link.diagnostics().join("\n");
  expect(log).toContain("link connected");
  expect(log).toMatch(/candidate host/);
  expect(log).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f-]{36}\.local/);
  a.link.close();
  b.link.close();
});

test("fails an answer that comes before any offer", async () => {
  const lone = endpoint();
  await expect(lone.link.acceptAnswer("v=0")).rejects.toThrow("Create an offer first.");
  expect(lone.states).toEqual(["failed"]);
  expect(lone.link.send("x")).toBe(false);
});

test("describes a candidate by type and protocol only", () => {
  expect(describeCandidate("candidate:1 1 udp 2122 abc-def.local 5000 typ host")).toBe(
    "host (mDNS) udp",
  );
  expect(describeCandidate("candidate:2 1 TCP 1 10.0.0.1 9 typ srflx")).toBe("srflx tcp");
  expect(describeCandidate("garbage")).toBe("unknown ?");
});

test("keeps one certificate per profile, renewed only near its expiry", async () => {
  const first = await persistentCertificate();
  const again = await persistentCertificate();
  expect(certificateFingerprint(again)).toBe(certificateFingerprint(first));
  const renewed = await persistentCertificate(first.expires);
  expect(certificateFingerprint(renewed)).not.toBe(certificateFingerprint(first));
});

test("runs each link command the background sends", async () => {
  const certificate = await generated();
  const { link } = endpoint(certificate);
  const run = (command: object) =>
    runLinkCommand(link, { target: "offscreen", ...command } as never, certificate);
  expect(await run({ type: "link-fingerprint" })).toEqual({
    fingerprint: certificateFingerprint(certificate),
  });
  const { sdp } = (await run({ type: "link-offer" })) as { sdp: string };
  expect(sdp).toContain("a=fingerprint:sha-256");
  expect(await run({ type: "link-send", frame: "x" })).toEqual({ sent: false });
  expect(await run({ type: "link-info" })).toMatchObject({ state: "connecting" });

  const other = endpoint(await generated());
  const answer = await other.link.acceptOffer(sdp);
  await run({ type: "link-accept-answer", sdp: answer });
  await vi.waitFor(() => expect(link.state()).toBe("connected"));
  await run({ type: "link-close" });
  expect(link.state()).toBe("disconnected");
  other.link.close();

  const responder = endpoint(await generated());
  const offer = await responder.link.createOffer();
  const answered = (await run({ type: "link-answer", sdp: offer })) as { sdp: string };
  expect(answered.sdp).toContain("a=fingerprint:sha-256");
  responder.link.close();
  link.close();
});
