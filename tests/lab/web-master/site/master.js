// Throwaway master of the website-master spike: offers, pins worker identities, pings.
const links = new Map();
const fingerprintOf = (sdp) => /^a=fingerprint:sha-256 (\S+)/im.exec(sdp)?.[1]?.toUpperCase() ?? "";
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const nextMessage = (channel, type) =>
  new Promise((resolve) => {
    const listener = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type !== type) return;
      channel.removeEventListener("message", listener);
      resolve(message);
    };
    channel.addEventListener("message", listener);
  });

const offer = async (name) => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel("recnrun-lab");
  const opened = new Promise((resolve) =>
    channel.addEventListener("open", () => resolve(performance.now())),
  );
  links.set(name, { pc, channel, opened });
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
  const { pc, channel } = links.get(name);
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
  const { signature } = await proof;
  const signed = `${nonce}|${fingerprintOf(pc.localDescription.sdp)}|${fingerprintOf(pc.remoteDescription.sdp)}`;
  const data = new TextEncoder().encode(signed);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signature), data);
};

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

window.lab = { offer, accept, authenticate, ping, selectedPair };
document.getElementById("status").textContent = "ready";
