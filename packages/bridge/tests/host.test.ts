import { sampleStep } from "@recnrun/domain/testing";
import { describe, expect, test, vi } from "vite-plus/test";
import { createBridgeClient, createBridgeHost, isRequestType } from "../src/index.ts";
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
    transport.send(messages.request("r1", "getSnapshot"));
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
    createBridgeHost(transport, handle, "1.0.0").stop();
    transport.send(messages.request("r1", "ping"));
    await settle();
    expect(handle).not.toHaveBeenCalled();
  });

  test("passes the validated payload to the handler", async () => {
    const transport = memoryTransport();
    const handle = vi.fn(async () => []);
    createBridgeHost(transport, handle, "1.0.0");
    transport.send(messages.request("r1", "listSteps", { workflowId: "wf-login" }));
    await settle();
    expect(handle).toHaveBeenCalledWith("listSteps", { workflowId: "wf-login" });
    expect(transport.sent.at(-1)).toEqual(messages.success("r1", []));
  });

  test("answers a malformed payload with an error instead of calling the handler", async () => {
    const transport = memoryTransport();
    const handle = vi.fn(async () => []);
    createBridgeHost(transport, handle, "1.0.0");
    transport.send(messages.request("r1", "listSteps", { workflowId: 7 }));
    await settle();
    expect(handle).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)).toEqual(messages.failure("r1", "Invalid listSteps payload."));
  });

  test("emits events to the page", () => {
    const transport = memoryTransport();
    const host = createBridgeHost(transport, vi.fn(), "1.0.0");
    const step = sampleStep();
    host.emit("stepRecorded", step);
    expect(transport.sent.at(-1)).toEqual(messages.event("stepRecorded", step));
  });

  test("completes a round trip with the client", async () => {
    const transport = memoryTransport();
    createBridgeHost(transport, async () => ({ extensionVersion: "3.1.0" }), "3.1.0");
    const client = createBridgeClient(transport, { timeoutMs: 30 });
    await expect(client.request("ping")).resolves.toEqual({ extensionVersion: "3.1.0" });
  });
});

describe("isRequestType", () => {
  test("accepts only request types the protocol defines", () => {
    expect(["ping", "getSnapshot", "startWorkflow", "listSteps"].every(isRequestType)).toBe(true);
    expect([undefined, "", "deleteEverything", 1].some(isRequestType)).toBe(false);
  });
});
