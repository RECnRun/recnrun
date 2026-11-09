import { describe, expect, test } from "vite-plus/test";
import { createInput } from "./site/input-client.js";

/* The master's input.v1 client over fake peer connections: which channel a message goes on. */

class FakeChannel extends EventTarget {
  readyState = "connecting";
  sent: { type: string }[] = [];
  send(data: string) {
    // RTCDataChannel throws InvalidStateError on a channel that is not open.
    if (this.readyState !== "open") throw new Error(`InvalidStateError: ${this.readyState}`);
    const message = JSON.parse(data) as { type: string };
    this.sent.push(message);
    queueMicrotask(() => this.reply(message));
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  private reply(message: { type: string }) {
    const data = JSON.stringify({ type: `${message.type}-reply`, ok: true });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const fakePc = () => {
  const channels: FakeChannel[] = [];
  const pc = {
    channels,
    createDataChannel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      queueMicrotask(() => channel.open());
      return channel;
    },
  };
  return pc;
};

describe("input.v1 session", () => {
  test("a new peer connection under the same name gets its own channel", async () => {
    const links = new Map<string, { pc: ReturnType<typeof fakePc> }>();
    const input = createInput({ links });
    const first = fakePc();
    links.set("worker", { pc: first });
    await expect(input.interactRaw("worker", { type: "PING" })).resolves.toMatchObject({
      ok: true,
    });
    // The old link's channel is still closing when the next offer replaces the link.
    (first.channels[0] as FakeChannel).readyState = "closing";
    const second = fakePc();
    links.set("worker", { pc: second });
    await expect(input.interactRaw("worker", { type: "PING" })).resolves.toMatchObject({
      ok: true,
    });
    expect(second.channels[0]?.sent).toEqual([{ type: "PING" }]);
  });
});
