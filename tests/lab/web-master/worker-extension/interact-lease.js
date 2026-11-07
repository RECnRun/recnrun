// W7 slice A: one lease at a time, bound to the link it began on; its seq moves by exactly one.
const KEEP_REVOKED = 32;

export const createLeases = ({ now = Date.now, leaseMs = 3_000 } = {}) => {
  let lease = null;
  /** @type {Map<string, string>} recent revoked lease ids → reason */
  const revoked = new Map();

  const open = ({ linkId, interactId, url }) => {
    lease = {
      leaseId: crypto.randomUUID(),
      interactId,
      linkId,
      url,
      seq: 0,
      until: now() + leaseMs,
    };
    return { ...lease };
  };

  const revoke = (reason) => {
    if (!lease) return null;
    const ended = { ...lease, reason };
    lease = null;
    revoked.set(ended.leaseId, reason);
    if (revoked.size > KEEP_REVOKED) revoked.delete(revoked.keys().next().value);
    return ended;
  };

  // Fails closed: the message that broke the lease names why, and the lease is gone.
  const broken = (reason) => ({ code: reason, ended: revoke(reason) });

  /** Null when a lease message from `linkId` may act, otherwise its refusal. */
  const admit = (message, linkId) => {
    if (!lease || message.leaseId !== lease.leaseId) {
      const reason = revoked.get(message.leaseId);
      return reason ? { code: "SESSION_REVOKED", reason } : { code: "NO_LEASE" };
    }
    // Another link never moves or breaks the lease: it is refused and nothing changes.
    if (linkId !== lease.linkId) return { code: "LINK_MISMATCH" };
    if (now() > lease.until) return broken("LEASE_EXPIRED");
    if (message.seq <= lease.seq) return broken("SEQ_REPLAY");
    if (message.seq > lease.seq + 1) return broken("SEQ_GAP");
    lease.seq = message.seq;
    return null;
  };

  return {
    open,
    admit,
    revoke,
    renew: () => {
      if (lease) lease.until = now() + leaseMs;
    },
    expired: () => Boolean(lease) && now() > lease.until,
    current: () => (lease ? { ...lease } : null),
  };
};
