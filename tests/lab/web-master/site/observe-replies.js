// W6 review: an observe request waits for its reply, its timeout, or its channel's close, never longer.
const TTL_MS = 10_000;

export const createReplies = ({ ttlMs = TTL_MS } = {}) => {
  const pending = new Map();

  const settle = (requestId, reply) => {
    const waiting = pending.get(requestId);
    if (!waiting) return;
    pending.delete(requestId);
    clearTimeout(waiting.timer);
    waiting.resolve(reply);
  };

  /** The reply to `requestId` on `channel`, or a TIMEOUT refusal after the request's own TTL. */
  const wait = (channel, requestId) =>
    new Promise((resolve) => {
      const expired = { ok: false, code: "TIMEOUT", requestId };
      const timer = setTimeout(() => settle(requestId, expired), ttlMs);
      pending.set(requestId, { resolve, timer, channel });
    });

  const closed = (channel) => {
    for (const [requestId, waiting] of pending) {
      if (waiting.channel === channel) settle(requestId, { ok: false, code: "CLOSED", requestId });
    }
  };

  return { settle, wait, closed, size: () => pending.size };
};
