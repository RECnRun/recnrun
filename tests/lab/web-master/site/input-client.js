// W7 slices A and B: the master's input.v1 client: signed start, renewals, frames, events, stop.
import { sign } from "./jobs.js";

const fingerprintOf = (sdp) => /^a=fingerprint:sha-256 (\S+)/im.exec(sdp)?.[1]?.toUpperCase() ?? "";
const REPLY_MS = 5_000;
const RENEW_MS = 1_000;
const START_TTL_MS = 10_000;
const FRAMES_KEPT = 128;
const POINTER = ["pointerMove", "pointerDown", "pointerUp"];
// A well-formed pointer that names no frame the worker sent, for refusal checks.
const UNAIMED = {
  x: 0.5,
  y: 0.5,
  button: "left",
  clickCount: 1,
  modifiers: 0,
  bootId: "00000000-0000-4000-8000-000000000000",
  sessionEpoch: 1,
  frameSeq: 1,
  loaderId: "0",
};

export const createInput = ({ links, onRevoked = () => undefined }) => {
  /** @type {Map<string, any>} link name → its input session */
  const sessions = new Map();

  const pause = (session) => {
    clearInterval(session.timer);
    session.timer = null;
  };

  // The frames the worker announced, by frameSeq; only these can be aimed at.
  const keepFrame = (session, message) => {
    const { type: _type, leaseId: _lease, ...frame } = message;
    session.frames.set(frame.frameSeq, frame);
    session.latest = frame;
    // A screenshot carries no geometry: the latest frame a pointer can aim at is kept apart.
    if (frame.geometry) session.aimable = frame;
    if (session.frames.size > FRAMES_KEPT)
      session.frames.delete(session.frames.keys().next().value);
  };

  const onMessage = (name, session, { data }) => {
    const message = JSON.parse(data);
    // Every message the page sends gets exactly one reply, in order; anything else is a push.
    if (message.type.endsWith("-reply")) return session.pending.shift()?.(message);
    if (message.type === "INTERACT_FRAME") return keepFrame(session, message);
    session.pushes.push(message);
    if (message.type !== "INTERACT_REVOKED") return;
    pause(session);
    onRevoked(name, message);
  };

  const open = (name) => {
    const known = sessions.get(name);
    if (known && known.channel.readyState !== "closed") return known.ready;
    const channel = links.get(name).pc.createDataChannel("input.v1", { ordered: true });
    const session = { channel, pending: [], pushes: [], lease: null, seq: 0, timer: null };
    Object.assign(session, { frames: new Map(), latest: null, aimable: null });
    session.ready = new Promise((resolve) =>
      channel.addEventListener("open", () => resolve(session)),
    );
    channel.addEventListener("close", () => pause(session));
    channel.addEventListener("message", (event) => onMessage(name, session, event));
    sessions.set(name, session);
    return session.ready;
  };

  const sendOn = (session, message) =>
    new Promise((resolve) => {
      // A missing reply breaks the pairing, so the channel is closed rather than reused.
      const timer = setTimeout(() => {
        resolve({ ok: false, code: "NO_REPLY" });
        session.channel.close();
      }, REPLY_MS);
      session.pending.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      session.channel.send(JSON.stringify(message));
    });

  const raw = async (name, message) => sendOn(await open(name), message);
  const leaseMessage = (session, type, extra = {}) => {
    session.seq += 1;
    return sendOn(session, { type, leaseId: session.lease.leaseId, seq: session.seq, ...extra });
  };

  const fingerprints = (name) => {
    const { pc } = links.get(name);
    const masterFingerprint = fingerprintOf(pc.localDescription.sdp);
    return { masterFingerprint, workerFingerprint: fingerprintOf(pc.remoteDescription.sdp) };
  };

  /** A signed start for `url`, not sent; `overrides` change fields before signing. */
  const prepare = async (name, url, overrides = {}) => {
    const challenge = await raw(name, {
      type: "INTERACT_CHALLENGE",
      requestId: crypto.randomUUID(),
    });
    if (!challenge.ok) return { challenge };
    const own = fingerprints(name);
    const proven = links.get(name).proven?.workerId;
    // The worker must name this page's view of the link and the worker id the link proved.
    const same = challenge.masterFingerprint === own.masterFingerprint;
    if (
      !same ||
      challenge.workerFingerprint !== own.workerFingerprint ||
      challenge.workerId !== proven
    )
      return { challenge: { ok: false, code: "LINK_MISMATCH" } };
    const iat = Date.now();
    const { nonce, bootId, workerId } = challenge;
    const fields = { type: "INTERACT_START", requestId: crypto.randomUUID(), workerId, bootId };
    const timing = { iat, exp: iat + START_TTL_MS };
    return {
      challenge,
      start: await sign({ ...fields, nonce, ...own, url, ...timing, ...overrides }),
    };
  };

  /** Sends a prepared start; an accepted one is renewed every second until it stops. */
  const send = async (name, start) => {
    const session = await open(name);
    const reply = await sendOn(session, start);
    if (!reply.ok) return reply;
    Object.assign(session, { lease: reply, seq: 0, latest: null, aimable: null });
    session.frames.clear();
    const renew = () =>
      void leaseMessage(session, "INTERACT_RENEW").then((renewed) => renewed.ok || pause(session));
    session.timer = setInterval(renew, RENEW_MS);
    return reply;
  };

  const begin = async (name, url) => {
    const { challenge, start } = await prepare(name, url);
    return start ? send(name, start) : challenge;
  };

  const stop = async (name) => {
    const session = sessions.get(name);
    pause(session);
    return leaseMessage(session, "INTERACT_STOP");
  };

  // A second input.v1 on the same link: answers whether the worker closed it.
  const duplicate = async (name) => {
    await open(name);
    const second = links.get(name).pc.createDataChannel("input.v1", { ordered: true });
    const closed = new Promise((resolve) => second.addEventListener("close", () => resolve(true)));
    return Promise.race([closed, new Promise((resolve) => setTimeout(resolve, REPLY_MS, false))]);
  };

  const session = (name) => {
    const { lease, seq, pushes, timer, channel } = sessions.get(name) ?? {};
    return { lease, seq, pushes, renewing: Boolean(timer), state: channel?.readyState };
  };

  return {
    interactStart: begin,
    interactPrepare: prepare,
    interactSend: send,
    interactRaw: raw,
    interactStop: stop,
    interactPause: (name) => pause(sessions.get(name)),
    interactEvent: (name, kind, fields = {}) => {
      const pointer = POINTER.includes(kind) ? UNAIMED : {};
      return leaseMessage(sessions.get(name), "INPUT_EVENT", { kind, ...pointer, ...fields });
    },
    interactRefresh: (name) => leaseMessage(sessions.get(name), "INTERACT_REFRESH"),
    interactFrame: (name, frameSeq) => sessions.get(name)?.frames.get(frameSeq) ?? null,
    interactLatest: (name) => sessions.get(name)?.latest ?? null,
    interactAimable: (name) => sessions.get(name)?.aimable ?? null,
    interactFingerprints: fingerprints,
    interactSession: session,
    interactDuplicate: duplicate,
    interactClose: (name) => sessions.get(name)?.channel.close(),
    // N10: the link itself lost, from the master's side.
    interactDropLink: (name) => {
      links.get(name).pc.close();
      return true;
    },
  };
};
