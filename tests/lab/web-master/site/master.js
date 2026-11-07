// Throwaway master of the website-master spike: offers, pins worker identities, pings, jobs.
import { createDashboard } from "./dashboard.js";
import { createFsa } from "./fsa.js";
import { createInput } from "./input-client.js";
import { createInteractView } from "./interact-view.js";
import { createJobs } from "./jobs.js";
import { createObserve } from "./observe-client.js";
import { plant, scan, scanText, unplant } from "./scan.js";
import { createVisual } from "./visual-view.js";

export const links = new Map();
const fingerprintOf = (sdp) => /^a=fingerprint:sha-256 (\S+)/im.exec(sdp)?.[1]?.toUpperCase() ?? "";
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const nextMessage = (channel, type) =>
  new Promise((resolve) => {
    const listener = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type !== type) return;
      channel.removeEventListener("message", listener);
      resolve(message);
    };
    channel.addEventListener("message", listener);
  });

const visual = createVisual({ links, nextMessage });
const observe = createObserve({ links, visual });
// A revoked lease ends the view of its tab: no later frame of it is shown.
const input = createInput({ links, onRevoked: (name) => visual.endSession(name, "revoked") });

const offer = async (name) => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel("recnrun-lab");
  // Frames go unordered and unretransmitted: a lost frame is replaced, never resent.
  const frames = pc.createDataChannel("visual.v1", { ordered: false, maxRetransmits: 0 });
  visual.attach(frames, name);
  const opened = new Promise((resolve) =>
    channel.addEventListener("open", () => resolve(performance.now())),
  );
  links.set(name, { pc, channel, opened, visual: frames });
  const complete = new Promise((resolve) => {
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve();
  });
  await pc.setLocalDescription(await pc.createOffer());
  await complete;
  return pc.localDescription.sdp;
};

const accept = async (name, sdp) => {
  const link = links.get(name);
  const started = performance.now();
  await link.pc.setRemoteDescription({ type: "answer", sdp });
  return (await link.opened) - started;
};

const authenticate = async (name, pinnedJwk) => {
  const link = links.get(name);
  const { pc, channel } = link;
  const key = await crypto.subtle.importKey(
    "jwk",
    pinnedJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const nonce = crypto.randomUUID();
  const proof = nextMessage(channel, "proof");
  channel.send(JSON.stringify({ type: "challenge", nonce }));
  const { signature, workerId } = await proof;
  const fingerprints = `${fingerprintOf(pc.localDescription.sdp)}|${fingerprintOf(pc.remoteDescription.sdp)}`;
  const signed = `${nonce}|${fingerprints}|${workerId}`;
  const data = new TextEncoder().encode(signed);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64(signature),
    data,
  );
  // Frames on this link are shown only for the worker id the verified proof names.
  if (ok) link.proven = { workerId };
  return { ok, reason: ok ? "verified" : "proof-not-signed-by-pinned-key" };
};

// A valid P-256 public key the worker does not hold, for the wrong-pinned-key control.
const otherKey = async () =>
  crypto.subtle.exportKey(
    "jwk",
    (
      await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])
    ).publicKey,
  );

const ping = async (name, count) => {
  const { channel } = links.get(name);
  const started = performance.now();
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const pong = nextMessage(channel, "pong");
    channel.send(JSON.stringify({ type: "ping", sequence }));
    if ((await pong).sequence !== sequence) throw new Error(`pong ${sequence} out of order`);
  }
  return performance.now() - started;
};

const candidate = (stats, id) => {
  const entry = stats.get(id);
  return {
    type: entry.candidateType,
    address: entry.address,
    port: entry.port,
    protocol: entry.protocol,
  };
};

const selectedPair = async (name) => {
  const stats = await links.get(name).pc.getStats();
  const transport = [...stats.values()].find((entry) => entry.type === "transport");
  const pair = stats.get(transport.selectedCandidatePairId);
  return {
    state: pair.state,
    local: candidate(stats, pair.localCandidateId),
    remote: candidate(stats, pair.remoteCandidateId),
  };
};

window.lab = {
  offer,
  accept,
  authenticate,
  otherKey,
  ping,
  selectedPair,
  ...createJobs({ links, nextMessage }),
  ...createFsa(),
  ...visual,
  ...observe,
  ...input,
  ...createInteractView({ input, visual, observe }),
  ...createDashboard({ links, visual, observe }),
  scan,
  scanText,
  plant,
  unplant,
};
document.getElementById("status").textContent = "ready";
