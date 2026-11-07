// W7 slice A: the master's input.v1 client: challenge, signed start, renewals each second, stop.
import { sign } from "./jobs.js";

const fingerprintOf = (sdp) => /^a=fingerprint:sha-256 (\S+)/im.exec(sdp)?.[1]?.toUpperCase() ?? "";
const REPLY_MS = 5_000;
const RENEW_MS = 1_000;
const START_TTL_MS = 10_000;

export const createInput = ({ links }) => {
  /** @type {Map<string, any>} link name → its input session */
  const sessions = new Map();

  const pause = (session) => {
    clearInterval(session.timer);
    session.timer = null;
  };

  const onMessage = (session, { data }) => {
    const message = JSON.parse(data);
    // Every message the page sends gets exactly one reply, in order; anything else is a push.
    if (message.type.endsWith("-reply")) return session.pending.shift()?.(message);
    session.pushes.push(message);
    if (message.type === "INTERACT_REVOKED") pause(session);
  };

  const open = (name) => {
    const known = sessions.get(name);
    if (known && known.channel.readyState !== "closed") return known.ready;
    const channel = links.get(name).pc.createDataChannel("input.v1", { ordered: true });
    const session = { channel, pending: [], pushes: [], lease: null, seq: 0, timer: null };
    session.ready = new Promise((resolve) =>
      channel.addEventListener("open", () => resolve(session)),
    );
    channel.addEventListener("close", () => pause(session));
    channel.addEventListener("message", (event) => onMessage(session, event));
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
    Object.assign(session, { lease: reply, seq: 0 });
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
    interactEvent: (name, kind) => leaseMessage(sessions.get(name), "INPUT_EVENT", { kind }),
    interactFingerprints: fingerprints,
    interactSession: session,
    interactDuplicate: duplicate,
    interactClose: (name) => sessions.get(name)?.channel.close(),
  };
};
