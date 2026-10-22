import { describe, expect, test, vi } from "vite-plus/test";
import { createWindowTransport } from "../src/index.ts";

class FakeWindow extends EventTarget {
  location = { origin: "https://recnrun.com" };
  posted: [unknown, string][] = [];

  postMessage(message: unknown, targetOrigin: string) {
    this.posted.push([message, targetOrigin]);
  }

  receive(data: unknown, origin: string, source: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
  }
}

function setup() {
  const target = new FakeWindow();
  const transport = createWindowTransport(target as unknown as Window);
  return { target, transport };
}

describe("createWindowTransport", () => {
  test("posts only to the page's own origin", () => {
    const { target, transport } = setup();
    transport.send({ hello: 1 });
    expect(target.posted).toEqual([[{ hello: 1 }, "https://recnrun.com"]]);
  });

  test("delivers messages from the same window and origin", () => {
    const { target, transport } = setup();
    const listener = vi.fn();
    transport.subscribe(listener);
    target.receive("same", "https://recnrun.com", target);
    expect(listener).toHaveBeenCalledWith("same");
  });

  test("drops messages from other origins or other windows", () => {
    const { target, transport } = setup();
    const listener = vi.fn();
    transport.subscribe(listener);
    target.receive("foreign origin", "https://evil.example", target);
    target.receive("frame", "https://recnrun.com", new FakeWindow());
    expect(listener).not.toHaveBeenCalled();
  });

  test("stops delivering after unsubscribe", () => {
    const { target, transport } = setup();
    const listener = vi.fn();
    transport.subscribe(listener)();
    target.receive("late", "https://recnrun.com", target);
    expect(listener).not.toHaveBeenCalled();
  });
});
