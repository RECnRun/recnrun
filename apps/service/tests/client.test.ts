import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createServiceClient, ServiceCallError } from "@/client";
import { startService, type RunningService } from "@/service";

let home = "";
let service: RunningService;
const chrome = {
  ok: false as const,
  code: "missing-file" as const,
  remedy: "r",
  userDataDir: "/x",
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-client-"));
  const started = await startService({
    home,
    discover: async () => chrome,
    handlers: {
      "flow.replay": async () => ({ runId: "run-1" }),
      "run.summary": async () => {
        throw new Error("no such run");
      },
    },
  });
  if (started.reused) throw new Error("unexpected reuse");
  service = started.service;
});
afterEach(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

test("a handler passed to startService answers its command, and the built-ins still answer", async () => {
  const client = createServiceClient(service);
  expect(await client.call("flow.replay", { flowId: "f" })).toEqual({ runId: "run-1" });
  expect(await client.call("health", {})).toMatchObject({ status: "ok", chrome });
});

test("an error envelope becomes a ServiceCallError with its code", async () => {
  const client = createServiceClient(service);
  const failure = await client.call("run.summary", { runId: "x" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ServiceCallError);
  expect(failure).toMatchObject({ code: "internal" });
});

test("a command with no handler answers capability-unavailable", async () => {
  const client = createServiceClient(service);
  const failure = await client.call("run.getArtifact", {}).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "capability-unavailable" });
});

test("a wrong token is unauthorized and a closed port is unreachable", async () => {
  const wrong = createServiceClient({ port: service.port, token: "x".repeat(43) });
  expect(await wrong.call("health", {}).catch((error: unknown) => error)).toMatchObject({
    code: "unauthorized",
  });
  await service.stop();
  const gone = createServiceClient(service);
  expect(await gone.call("health", {}).catch((error: unknown) => error)).toMatchObject({
    code: "unreachable",
  });
});
