// Throwaway worker link: one ECDSA identity, answers offers with iceServers [], signs challenges.
const identity = crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
  "sign",
  "verify",
]);
const links = [];
const channels = new Set();
const RELAYED = new Set(["job", "job-status"]);

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

const serve = (channel, offerFingerprint, answerFingerprint) => {
  channels.add(channel);
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
    if (message.type === "ping") {
      channel.send(JSON.stringify({ type: "pong", sequence: message.sequence }));
      return;
    }
    if (message.type !== "challenge") return;
    const signed = `${message.nonce}|${offerFingerprint}|${answerFingerprint}`;
    channel.send(JSON.stringify({ type: "proof", signature: await sign(signed) }));
  };
};

const answer = async (offer) => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  links.push(pc);
  pc.oniceconnectionstatechange = () => LOST.has(pc.iceConnectionState) && linkClosed();
  pc.ondatachannel = ({ channel }) =>
    serve(channel, fingerprintOf(offer), fingerprintOf(pc.localDescription.sdp));
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
  if (message.type === "push") {
    const open = [...channels].filter((channel) => channel.readyState === "open");
    for (const channel of open) channel.send(JSON.stringify(message.message));
    return false;
  }
  const work = message.type === "answer" ? answer(message.offer) : publicKey();
  work.then(respond, (error) => respond({ error: String(error) }));
  return true;
});
