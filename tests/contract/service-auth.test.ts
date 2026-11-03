import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import { CAPABILITY_MATRIX } from "../../packages/protocol/src/index.ts";
import { command, NO_CHROME, send, startFresh, tempHome, upgradeStatus } from "./helpers.ts";

const health = { requestId: "r-1", command: "health", params: {} };

let home = "";
let service: RunningService;
beforeEach(async () => {
  home = await tempHome();
  service = await startFresh(home);
});
afterEach(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

const errorCode = (json: unknown) => (json as { error?: { code?: string } }).error?.code;

test("a request without a token is refused with 401", async () => {
  const response = await send(service.port, { body: JSON.stringify(health) });
  expect(response.status).toBe(401);
  expect(response.headers["www-authenticate"]).toBe("Bearer");
  expect(errorCode(response.json)).toBe("unauthorized");
});

test("a wrong token is refused with 401", async () => {
  const response = await send(service.port, {
    headers: { authorization: `Bearer ${"x".repeat(43)}` },
    body: JSON.stringify(health),
  });
  expect(response.status).toBe(401);
});

test("a foreign Origin is refused with 403 even with the token", async () => {
  const response = await command(service, health, { origin: "https://evil.example" });
  expect(response.status).toBe(403);
  expect(errorCode(response.json)).toBe("forbidden");
});

test("a Host that is not the loopback socket is refused with 403", async () => {
  const response = await command(service, health, { host: `evil.example:${service.port}` });
  expect(response.status).toBe(403);
});

test("the service's own origins and clients without Origin are served", async () => {
  for (const origin of [`http://127.0.0.1:${service.port}`, `http://localhost:${service.port}`])
    expect((await command(service, health, { origin })).status).toBe(200);
  expect((await command(service, health, { host: `localhost:${service.port}` })).status).toBe(200);
});

test("health answers with the version, pid, uptime, and Chrome discovery", async () => {
  const response = await command(service, health);
  expect(response.status).toBe(200);
  expect(response.json).toEqual({
    requestId: "r-1",
    ok: true,
    result: {
      status: "ok",
      serviceVersion: "0.0.0",
      protocolVersion: 1,
      pid: process.pid,
      uptimeMs: expect.any(Number),
      chrome: NO_CHROME,
    },
  });
});

test("health carries a DevToolsActivePort the operating system blocks, not internal", async () => {
  const blocked = {
    ...NO_CHROME,
    code: "unreadable-file" as const,
    remedy:
      "macOS blocks reading /Users/ana/Library/Application Support/Google/Chrome/DevToolsActivePort.",
  };
  const other = await tempHome();
  const started = await startService({ home: other, discover: async () => blocked });
  if (started.reused) throw new Error("unexpected reuse");
  try {
    const response = await command(started.service, health);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ok: true, result: { chrome: blocked } });
  } finally {
    await started.service.stop();
    await rm(other, { recursive: true, force: true });
  }
});

test("capabilities.get returns the protocol's capability matrix", async () => {
  const request = { requestId: "r-2", command: "capabilities.get", params: {} };
  expect((await command(service, request)).json).toEqual({
    requestId: "r-2",
    ok: true,
    result: CAPABILITY_MATRIX,
  });
});

test.each([
  ["a body that is not JSON", "{", "none"],
  [
    "an unknown command",
    JSON.stringify({ requestId: "r-3", command: "shell.exec", params: {} }),
    "r-3",
  ],
  [
    "params the command does not take",
    JSON.stringify({ ...health, params: { deep: true } }),
    "r-1",
  ],
])("%s is a 400 invalid-request", async (_name, body, requestId) => {
  const response = await send(service.port, {
    headers: { authorization: `Bearer ${service.token}` },
    body,
  });
  expect(response.status).toBe(400);
  expect(response.json).toMatchObject({ requestId, ok: false, error: { code: "invalid-request" } });
});

test("a command a later phase implements answers capability-unavailable", async () => {
  const response = await command(service, {
    requestId: "r-4",
    command: "session.start",
    params: {},
  });
  expect(response.json).toMatchObject({ ok: false, error: { code: "capability-unavailable" } });
});

test("only POST /api is served", async () => {
  const authorization = `Bearer ${service.token}`;
  expect((await send(service.port, { method: "GET", headers: { authorization } })).status).toBe(
    405,
  );
  expect((await send(service.port, { path: "/other", headers: { authorization } })).status).toBe(
    404,
  );
});

test("a WebSocket without a token is closed with 4401", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
  const closed = await new Promise<CloseEvent>((resolve) =>
    socket.addEventListener("close", resolve),
  );
  expect(closed.code).toBe(4401);
});

test("a WebSocket upgrade from a foreign Origin or Host is refused with 403", async () => {
  const authorization = `Bearer ${service.token}`;
  expect(await upgradeStatus(service.port, { authorization, origin: "https://evil.example" })).toBe(
    403,
  );
  expect(
    await upgradeStatus(service.port, { authorization, host: `evil.example:${service.port}` }),
  ).toBe(403);
  expect(await upgradeStatus(service.port, { authorization })).toBe(101);
});

test("a WebSocket with the token answers command envelopes", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws?token=${service.token}`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const reply = new Promise<MessageEvent>((resolve) => socket.addEventListener("message", resolve));
  socket.send(JSON.stringify(health));
  expect(JSON.parse(String((await reply).data))).toMatchObject({ requestId: "r-1", ok: true });
  socket.close();
});

test("a second start reuses the running instance and its port and token", async () => {
  const second = await startService({ home, discover: async () => NO_CHROME });
  expect(second).toEqual({
    reused: true,
    state: expect.objectContaining({ port: service.port, token: service.token, pid: process.pid }),
  });
});
