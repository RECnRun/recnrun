// The master's viewport match: a debounced sender, one request in flight, and a stale-frame gate.
const same = (a, b) => Boolean(a && b && a.width === b.width && a.height === b.height);

export const createViewport = ({
  send,
  delay = 300,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let timer = null;
  let last = null;
  let wanted = null;
  let sent = null;
  let flight = null;
  let effective = null;
  let seq = 0;

  const deliver = async () => {
    while (wanted) {
      const size = wanted;
      wanted = null;
      if (same(size, sent)) continue;
      const reply = await send(size).catch(() => null);
      if (!reply?.ok) continue;
      sent = size;
      effective = reply.effective ?? size;
      seq = Math.max(seq, reply.viewportSeq ?? 0);
    }
  };

  // Cleared once settled, not inside deliver: a deliver with nothing to send ends synchronously.
  const run = () => {
    flight ??= deliver().finally(() => {
      flight = null;
      if (wanted && timer === null) void run();
    });
    return flight;
  };

  return {
    observe: (size) => {
      last = size;
      wanted = size;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void run();
      }, delay);
    },
    now: () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      wanted = last ?? wanted;
      return run();
    },
    reset: () => {
      sent = null;
      effective = null;
      seq = 0;
    },
    effective: () => effective,
    // A frame cut before the last accepted resize shows the old geometry and must not be aimed at.
    accepts: (frame) => typeof frame.viewportSeq !== "number" || frame.viewportSeq >= seq,
  };
};

// INTERACT_VIEWPORT rides the lease; a reply without viewportSeq echoes the message's own seq.
export const sessionViewport = (session, leaseMessage) => {
  session.viewport ??= createViewport({
    send: async (size) => {
      if (!session.lease) return { ok: false, code: "NO_LEASE" };
      const viewportSeq = session.seq + 1;
      const reply = await leaseMessage(session, "INTERACT_VIEWPORT", size);
      return { viewportSeq, ...reply };
    },
  });
  return session.viewport;
};

export const watchSize = (viewport, element) => {
  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    viewport.observe({ width: Math.round(width), height: Math.round(height) });
  });
  observer.observe(element);
  return () => observer.disconnect();
};
