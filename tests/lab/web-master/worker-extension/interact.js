// W7 slice A: link-bound interactive sessions; they share the runner's admission and claim.
import { bootId } from "./capture.js";
import { createStartCheck } from "./input-check.js";
import { INPUT_TYPES, inputError } from "./input-schema.js";
import { createLeases } from "./interact-lease.js";
import { claimInteraction, claimed, releaseInteraction } from "./runner.js";

const TICK_MS = 250;
const limits = { leaseMs: 3_000, renewMs: 1_000 };
const starts = createStartCheck();
const leases = createLeases({ leaseMs: limits.leaseMs });
const stats = { started: 0, refused: {}, revoked: {}, errors: [] };

const provision = async () => (await chrome.storage.local.get("provision")).provision;
const latched = async () => (await chrome.storage.local.get("interactStop")).interactStop === true;

// Interaction is off unless provisioning turned it on, and a latched stop holds until cleared.
const gateError = async (provisioned) => {
  if (!provisioned?.masterKey) return "UNPROVISIONED";
  if (provisioned.interactEnabled !== true) return "INTERACT_DISABLED";
  return (await latched()) ? "WORKER_STOPPED" : null;
};

const count = (bucket, code) => {
  bucket[code] = (bucket[code] ?? 0) + 1;
};
const refuse = (code, extra = {}) => {
  count(stats.refused, code);
  return { ok: false, code, ...extra };
};

const end = (ended) => {
  if (!ended) return;
  count(stats.revoked, ended.reason);
  // B: close the interactive tab and release pressed state before the claim is freed.
  releaseInteraction(ended.interactId);
  const { leaseId, interactId, reason } = ended;
  const message = { type: "INTERACT_REVOKED", leaseId, interactId, reason };
  const push = { target: "offscreen", type: "input-push", linkId: ended.linkId, message };
  void chrome.runtime.sendMessage(push).catch(() => false);
};

const challenge = async (link) => {
  const refused = await gateError(await provision());
  if (refused) return refuse(refused);
  const nonce = starts.issue(link.linkId);
  if (!nonce) return refuse("RATE_LIMITED");
  const { masterFingerprint, workerFingerprint } = link;
  const workerId = chrome.runtime.id;
  return { ok: true, nonce, bootId: bootId(), workerId, masterFingerprint, workerFingerprint };
};

const start = async (message, link) => {
  const verify = async () => {
    const provisioned = await provision();
    const refused = await gateError(provisioned);
    if (refused) return refused;
    const { masterKey, allowlist } = provisioned;
    const context = { masterKey, allowlist, workerId: chrome.runtime.id, bootId: bootId(), link };
    return starts.check(message, context);
  };
  const claim = await claimInteraction(crypto.randomUUID(), verify);
  if (claim.status !== "CLAIMED") return refuse(claim.status);
  const lease = leases.open({
    linkId: link.linkId,
    interactId: claim.interactId,
    url: message.url,
  });
  stats.started += 1;
  return { ok: true, leaseId: lease.leaseId, interactId: lease.interactId, ...limits };
};

const onLease = (message, link) => {
  const refusal = leases.admit(message, link.linkId);
  if (refusal) {
    end(refusal.ended);
    return refuse(refusal.code, refusal.reason ? { reason: refusal.reason } : {});
  }
  const { leaseId, seq } = message;
  if (message.type === "INTERACT_RENEW") leases.renew();
  else if (message.type === "INTERACT_STOP") end(leases.revoke("STOPPED"));
  // Slices B and C dispatch events; until then each is refused but keeps its seq.
  else return refuse("INPUT_UNSUPPORTED", { leaseId, seq });
  return { ok: true, leaseId, seq };
};

const dispatch = async (message, link) => {
  const invalid = inputError(message);
  if (invalid) return refuse(invalid);
  if (message.type === "INTERACT_CHALLENGE") return challenge(link);
  if (message.type === "INTERACT_START") return start(message, link);
  return onLease(message, link);
};

const replyType = (message) =>
  INPUT_TYPES.includes(message?.type) ? `${message.type}-reply` : "INPUT-reply";

let queue = Promise.resolve();
const serial = (work) => {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
};

/** One input.v1 message from `link`; messages are handled one at a time, in arrival order. */
export const input = (message, link) =>
  serial(async () => {
    // Every message gets exactly one reply, so the master's FIFO pairing never slips.
    const reply = await dispatch(message, link).catch((error) => {
      stats.errors.push(String(error));
      return refuse("WORKER_ERROR");
    });
    return { type: replyType(message), ...reply };
  });

/** A closed input channel or link ends its lease and voids its outstanding challenges. */
export const interactLinkClosed = (linkId) =>
  serial(() => {
    starts.forget(linkId);
    if (leases.current()?.linkId === linkId) end(leases.revoke("LINK_CLOSED"));
  });

setInterval(() => {
  if (leases.expired()) void serial(() => end(leases.revoke("LEASE_EXPIRED")));
}, TICK_MS);

export const interactLab = {
  // The worker-local stop: it holds across starts until `clear`.
  stop: () =>
    serial(async () => {
      await chrome.storage.local.set({ interactStop: true });
      end(leases.revoke("WORKER_STOP"));
      return true;
    }),
  clear: () => chrome.storage.local.remove("interactStop").then(() => true),
  state: () => ({
    lease: leases.current(),
    claim: claimed(),
    stats,
    limits,
    starts: starts.sizes(),
  }),
};
