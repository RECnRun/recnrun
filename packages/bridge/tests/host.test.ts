import * as v from "valibot";
import { describe, expect, test, vi } from "vite-plus/test";
import { createBridgeClient, createBridgeHost, RequestTypeSchema } from "../src/index.ts";
import { messages } from "../src/protocol.ts";
import { memoryTransport } from "./memory-transport.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBridgeHost", () => {
  test("announces the extension version on start", () => {
    const transport = memoryTransport();
    createBridgeHost(transport, vi.fn(), "1.0.0");
    expect(transport.sent).toEqual([messages.announce("1.0.0")]);
  });

  test("answers known requests with the handler result", async () => {
    const transport = memoryTransport();
    createBridgeHost(transport, async (type) => ({ handled: type }), "1.0.0");
    transport.send(messages.request("r1", "ping"));
    await settle();
    expect(transport.sent.at(-1)).toEqual(messages.success("r1", { handled: "ping" }));
  });

  test("turns handler failures into error responses", async () => {
    const transport = memoryTransport();
    createBridgeHost(transport, () => Promise.reject(new Error("No storage")), "1.0.0");
    transport.send(messages.request("r1", "ping"));
    await settle();
    expect(transport.sent.at(-1)).toEqual(messages.failure("r1", "No storage"));
  });

  test("ignores unknown request types, responses, and foreign messages", async () => {
    const transport = memoryTransport();
    const handle = vi.fn(async () => "never");
    createBridgeHost(transport, handle, "1.0.0");
    transport.send({ ...messages.request("r1", "ping"), type: "deleteEverything" });
    transport.send(messages.success("r2", {}));
    transport.send("hello");
    await settle();
    expect(handle).not.toHaveBeenCalled();
  });

  test("stops answering once stopped", async () => {
    const transport = memoryTransport();
    const handle = vi.fn(async () => "pong");
    const stop = createBridgeHost(transport, handle, "1.0.0");
    stop();
    transport.send(messages.request("r1", "ping"));
    await settle();
    expect(handle).not.toHaveBeenCalled();
  });

  test("completes a round trip with the client", async () => {
    const transport = memoryTransport();
    createBridgeHost(transport, async () => ({ extensionVersion: "3.1.0" }), "3.1.0");
    const client = createBridgeClient(transport, { timeoutMs: 30 });
    await expect(client.request("ping")).resolves.toEqual({ extensionVersion: "3.1.0" });
  });
});

describe("RequestTypeSchema", () => {
  test("accepts only request types the protocol defines", () => {
    expect(v.is(RequestTypeSchema, "ping")).toBe(true);
    expect(v.is(RequestTypeSchema, "open-dashboard")).toBe(true);
    // The dashboard reads storage itself, so no page can ask for the user's recordings.
    const others = [undefined, "", "getSnapshot", "deleteEverything", 1];
    expect(others.some((value) => v.is(RequestTypeSchema, value))).toBe(false);
  });
});
