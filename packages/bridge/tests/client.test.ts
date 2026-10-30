import { emptySnapshot } from "@recnrun/domain";
import { sampleStep, sampleSteps, sampleWorkflow } from "@recnrun/domain/testing";
import { describe, expect, test, vi } from "vite-plus/test";
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
    replyWith(messages.success("req-1", emptySnapshot()));
    await expect(client.request("getSnapshot")).resolves.toEqual(emptySnapshot());
  });

  test("ignores responses to other requests", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("someone-else", emptySnapshot()));
    await expect(client.request("getSnapshot")).rejects.toThrow(/Timed out/);
  });

  test("rejects with the error the extension reported", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.failure("req-1", "Storage unavailable"));
    await expect(client.request("getSnapshot")).rejects.toThrow(
      new BridgeError("Storage unavailable"),
    );
  });

  test("rejects a result that does not match the schema", async () => {
    const { client, replyWith } = setup();
    replyWith(messages.success("req-1", { schemaVersion: 1 }));
    await expect(client.request("getSnapshot")).rejects.toThrow(/invalid getSnapshot result/);
  });

  test("sends the payload with the request", async () => {
    const { client, transport, replyWith } = setup();
    replyWith(messages.success("req-1", sampleSteps()));
    await expect(client.request("listSteps", { workflowId: "wf-login" })).resolves.toEqual(
      sampleSteps(),
    );
    expect(transport.sent[0]).toEqual(
      messages.request("req-1", "listSteps", { workflowId: "wf-login" }),
    );
  });

  test("lets a request without payload omit it", async () => {
    const { client, transport, replyWith } = setup();
    replyWith(messages.success("req-1", sampleWorkflow()));
    await expect(client.request("stopWorkflow")).resolves.toEqual(sampleWorkflow());
    expect(transport.sent[0]).toEqual(messages.request("req-1", "stopWorkflow"));
  });
});

describe("subscribe", () => {
  test("delivers validated events by name", () => {
    const { client, transport } = setup();
    const step = sampleStep();
    const onStep = vi.fn();
    const onStatus = vi.fn();
    client.subscribe("stepRecorded", onStep);
    client.subscribe("recordingChanged", onStatus);
    transport.send(messages.event("stepRecorded", step));
    expect(onStep).toHaveBeenCalledWith(step);
    expect(onStatus).not.toHaveBeenCalled();
  });

  test("ignores malformed event data and stops after unsubscribe", () => {
    const { client, transport } = setup();
    const step = sampleStep();
    const listener = vi.fn();
    const stop = client.subscribe("stepRecorded", listener);
    transport.send(messages.event("stepRecorded", { ...step, author: "robot" }));
    transport.send({ ...messages.event("stepRecorded", step), channel: "other" });
    expect(listener).not.toHaveBeenCalled();
    stop();
    transport.send(messages.event("stepRecorded", step));
    expect(listener).not.toHaveBeenCalled();
  });
});
