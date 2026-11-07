// Throwaway worker link: one ECDSA identity, answers offers with iceServers [], signs challenges.
import { OBSERVE_TYPES } from "./observe-schema.js";
import { createSender } from "./visual-sender.js";

const identity = crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
  "sign",
  "verify",
]);
const links = [];
/** @type {Map<RTCDataChannel, string>} control channel → its link's id */
const channels = new Map();
const RELAYED = new Set(["job", "job-status"]);
/** @type {Map<string, RTCPeerConnection>} link id → its peer connection */
const peers = new Map();
const OBSERVE = new Set(OBSERVE_TYPES);
const visual = createSender();

const fingerprintOf = (sdp) => /^a=fingerprint:sha-256 (\S+)/im.exec(sdp)?.[1]?.toUpperCase() ?? "";
const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));

const sign = async (text) => {
  const { privateKey } = await identity;
  const data = new TextEncoder().encode(text);
  return toBase64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
};

// A closed page may send no SCTP abort; ICE consent loss is then the first sign.
const LOST = new Set(["disconnected", "failed", "closed"]);
const linkClosed = () => void chrome.runtime.sendMessage({ target: "runner", type: "link-closed" });

const relay = async (channel, message) => {
  const reply = await chrome.runtime.sendMessage({ target: "runner", ...message });
  channel.send(JSON.stringify({ type: `${message.type}-reply`, ...reply }));
};

// The request goes as data under its own key: the closed schema sees exactly what the master sent.
const relayObserve = async (channel, request) => {
  const linkId = channels.get(channel);
  const reply = await chrome.runtime.sendMessage({
    target: "runner",
    type: "observe",
    linkId,
    request,
  });
  channel.send(JSON.stringify({ type: `${request.type}-reply`, ...reply }));
};

const serve = (channel, fingerprints, pc) => {
  const [offerFingerprint, answerFingerprint] = fingerprints;
  const linkId = crypto.randomUUID();
  channels.set(channel, linkId);
  peers.set(linkId, pc);
  channel.onclose = () => {
    channels.delete(channel);
    linkClosed();
  };
  channel.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (RELAYED.has(message.type)) {
      await relay(channel, message);
      return;
    }
    if (OBSERVE.has(message.type)) {
      await relayObserve(channel, message);
      return;
    }
    if (message.type === "ping") {
      channel.send(JSON.stringify({ type: "pong", sequence: message.sequence }));
      return;
    }
    if (message.type !== "challenge") return;
    // The proof names the worker id its frames carry, so the master can bind frames to it.
    const workerId = chrome.runtime.id;
    const signed = `${message.nonce}|${offerFingerprint}|${answerFingerprint}|${workerId}`;
    channel.send(JSON.stringify({ type: "proof", signature: await sign(signed), workerId }));
  };
};

const answer = async (offer) => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  links.push(pc);
  pc.oniceconnectionstatechange = () => LOST.has(pc.iceConnectionState) && linkClosed();
  // Frames and control never share a channel: visual.v1 gets no handler of recnrun-lab.
  pc.ondatachannel = ({ channel }) => {
    if (channel.label === "visual.v1") visual.attach(channel, pc);
    else if (channel.label === "recnrun-lab") {
      serve(channel, [fingerprintOf(offer), fingerprintOf(pc.localDescription.sdp)], pc);
    } else channel.close();
  };
  const complete = new Promise((resolve) => {
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve();
  });
  await pc.setRemoteDescription({ type: "offer", sdp: offer });
  await pc.setLocalDescription(await pc.createAnswer());
  await complete;
  return pc.localDescription.sdp;
};

const publicKey = async () => crypto.subtle.exportKey("jwk", (await identity).publicKey);

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "visual-frame") {
    visual.relayed(message.frame);
    return false;
  }
  if (message.type === "visual-burst") {
    respond(visual.burst(message.count, message.padBytes));
    return false;
  }
  if (message.type === "visual-stats") {
    respond(visual.stats());
    return false;
  }
  // An accepted start selects its link before the capture begins, so no first frame is lost.
  if (message.type === "visual-select") {
    visual.select(peers.get(message.linkId));
    respond(true);
    return false;
  }
  if (message.type === "visual-clear") {
    visual.clear();
    return false;
  }
  if (message.type === "push") {
    // A message for one link goes to that link only; job events go to every open link.
    const open = [...channels].filter(([channel, linkId]) => {
      if (channel.readyState !== "open") return false;
      return !message.linkId || message.linkId === linkId;
    });
    for (const [channel] of open) channel.send(JSON.stringify(message.message));
    return false;
  }
  const work = message.type === "answer" ? answer(message.offer) : publicKey();
  work.then(respond, (error) => respond({ error: String(error) }));
  return true;
});
