import { describe, expect, test } from "vite-plus/test";
import { BridgeError, createBridgeClient } from "../src/index.ts";
import { messages } from "../src/protocol.ts";
import { memoryTransport } from "./memory-transport.ts";

function setup() {
  const transport = memoryTransport();
  const client = createBridgeClient(transport, { timeoutMs: 30, createId: () => "req-1" });
  const replyWith = (message: unknown) =>
    transport.subscribe((sent) => {
      if ((sent as { kind?: string }).kind === "request") transport.send(message);
    });
  return { transport, client, replyWith };
}

describe("detect", () => {
  test("reports the extension version from a ping response", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", { extensionVersion: "1.2.3" }));
    await expect(client.detect()).resolves.toEqual({
      status: "installed",
      extensionVersion: "1.2.3",
    });
  });

  test("accepts an announcement when the ping goes unanswered", async () => {
    const { client, transport } = setup();
    const detection = client.detect();
    transport.send(messages.announce("2.0.0"));
    await expect(detection).resolves.toEqual({ status: "installed", extensionVersion: "2.0.0" });
  });

  test("reports a missing extension after the timeout", async () => {
    const { client } = setup();
    await expect(client.detect()).resolves.toEqual({ status: "missing" });
  });

  test("ignores look-alike messages from another channel or protocol", async () => {
    const { client, transport } = setup();
    const detection = client.detect();
    transport.send({ ...messages.announce("9.9.9"), channel: "other" });
    transport.send({ ...messages.announce("9.9.9"), protocol: 2 });
    await expect(detection).resolves.toEqual({ status: "missing" });
  });
});

describe("request", () => {
  test("resolves with the validated result", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", { extensionVersion: "1.0.0" }));
    await expect(client.request("ping")).resolves.toEqual({ extensionVersion: "1.0.0" });
  });

  test("ignores responses to other requests", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("someone-else", { extensionVersion: "1.0.0" }));
    await expect(client.request("ping")).rejects.toThrow(/Timed out/);
  });

  test("rejects with the error the extension reported", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.failure("req-1", "Storage unavailable"));
    await expect(client.request("ping")).rejects.toThrow(new BridgeError("Storage unavailable"));
  });

  test("asks the extension to bring its dashboard forward, which returns nothing to the page", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", {}));
    await expect(client.request("open-dashboard")).resolves.toEqual({});
  });

  test("rejects an open-dashboard result that is not an object", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", null));
    await expect(client.request("open-dashboard")).rejects.toThrow(/invalid open-dashboard result/);
  });

  test("rejects a result that does not match the schema", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", { extensionVersion: 1 }));
    await expect(client.request("ping")).rejects.toThrow(/invalid ping result/);
  });
});
