// W7 slice A: the offscreen end of input.v1, one ordered, reliable channel per link.
const MAX_INPUT_BYTES = 16_384;

const reliable = (channel) =>
  channel.ordered && channel.maxRetransmits === null && channel.maxPacketLifeTime === null;

const parsed = (data) => {
  if (typeof data !== "string" || data.length > MAX_INPUT_BYTES) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const send = (channel, message) => {
  if (channel.readyState === "open") channel.send(JSON.stringify(message));
};

export const createInputs = () => {
  /** @type {Map<string, RTCDataChannel>} link id → its input channel */
  const inputs = new Map();

  /** `link` is { linkId, masterFingerprint, workerFingerprint } of the connection it arrived on. */
  const attach = (channel, link) => {
    // A second or a lossy input channel is closed unheard: order and delivery are what seq relies on.
    if (inputs.has(link.linkId) || !reliable(channel)) {
      channel.close();
      return;
    }
    inputs.set(link.linkId, channel);
    channel.onclose = () => {
      if (inputs.get(link.linkId) === channel) inputs.delete(link.linkId);
      const closed = { target: "runner", type: "input-closed", linkId: link.linkId };
      void chrome.runtime.sendMessage(closed).catch(() => false);
    };
    channel.onmessage = ({ data }) => {
      // Forwarded with no await before it, so the worker sees messages in arrival order.
      const forwarded = { target: "runner", type: "input", link, message: parsed(data) };
      chrome.runtime.sendMessage(forwarded).then(
        (reply) => send(channel, reply),
        () => send(channel, { type: "INPUT-reply", ok: false, code: "WORKER_UNAVAILABLE" }),
      );
    };
  };

  const push = (linkId, message) => {
    const channel = inputs.get(linkId);
    if (channel) send(channel, message);
    return true;
  };

  return { attach, push };
};
