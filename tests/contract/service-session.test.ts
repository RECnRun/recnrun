import { mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import {
  SERVICE_COMMANDS,
  ServiceMessageSchema,
  type CommandName,
  type Lease,
  type ServiceMessage,
} from "../../packages/protocol/src/index.ts";
import { fakeChrome, SEND_TARGET, typedAndSent, type FakeChrome } from "./fake-chrome.ts";
import { command, tempHome } from "./helpers.ts";

let home = "";
let chrome: FakeChrome;
let service: RunningService;

beforeEach(async () => {
  home = await tempHome();
  const uiRoot = join(home, "ui-dist");
  await mkdir(join(uiRoot, "assets"), { recursive: true });
  await writeFile(
    join(uiRoot, "index.html"),
    "<!doctype html><html><head></head><body></body></html>",
  );
  await writeFile(join(uiRoot, "assets", "app-1.js"), "export {};");
  chrome = fakeChrome();
  const started = await startService({ home, adapter: chrome.adapter, uiRoot });
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  service = started.service;
});

afterEach(async () => {
  chrome.release();
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

let next = 0;

interface Standard {
  "~standard": { validate(value: unknown): { issues?: unknown } | Promise<unknown> };
}

/** Checks a value against a protocol schema through its Standard Schema interface. */
function conforms(schema: Standard, value: unknown): boolean {
  const outcome = schema["~standard"].validate(value);
  return !(outcome instanceof Promise) && outcome.issues === undefined;
}

/** Sends a command and checks its result against the protocol; answers the envelope. */
async function call(name: CommandName, params: unknown, lease?: Lease) {
  next += 1;
  const fence = lease && { leaseId: lease.leaseId, fencingToken: lease.fencingToken };
  const body = { requestId: `r-${next}`, command: name, params, ...(fence && { lease: fence }) };
  const { json } = await command(service, body);
  const envelope = json as { ok: boolean; result?: unknown; error?: { code: string } };
  if (envelope.ok) expect(conforms(SERVICE_COMMANDS[name].result, envelope.result)).toBe(true);
  return envelope;
}

async function result<T>(name: CommandName, params: unknown, lease?: Lease): Promise<T> {
  const envelope = await call(name, params, lease);
  expect(envelope).toMatchObject({ ok: true });
  return envelope.result as T;
}

function getText(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: service.port,
          path,
          headers: { host: `127.0.0.1:${service.port}`, ...headers },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    },
  );
}

/** A `/ws` subscriber that keeps every pushed message. */
async function subscribe(): Promise<{ pushed: ServiceMessage[]; close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws?token=${service.token}`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const pushed: ServiceMessage[] = [];
  const replied = new Promise<unknown>((resolve) =>
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message === "object" && message !== null && "requestId" in message)
        resolve(message);
      else if (conforms(ServiceMessageSchema, message)) pushed.push(message as ServiceMessage);
      else throw new Error(`A pushed message does not match the protocol: ${String(event.data)}`);
    }),
  );
  socket.send(JSON.stringify({ requestId: "sub", command: "events.subscribe", params: {} }));
  expect(await replied).toMatchObject({ ok: true, result: { subscriptionId: expect.any(String) } });
  return { pushed, close: () => socket.close() };
}

test("GET / serves the UI with the token meta and the CSP; a foreign Origin is refused", async () => {
  const page = await getText("/");
  expect(page.status).toBe(200);
  expect(page.body.includes(`<meta name="recnrun-token" content="${service.token}">`)).toBe(true);
  expect(page.headers["content-security-policy"]).toContain(
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:",
  );
  expect(page.headers["cache-control"]).toBe("no-store");
  expect((await getText("/assets/app-1.js")).body).toBe("export {};");
  const foreign = await getText("/", { origin: "https://evil.example" });
  expect(foreign.status).toBe(403);
  expect(foreign.body.includes(service.token)).toBe(false);
});

test("a recorded session becomes a stored flow that replays to a summary and events", async () => {
  const events = await subscribe();
  type Status = { sessionId: string; state: string; control: string; lease?: Lease };
  const status = await result<Status>("session.start", {});
  const { sessionId, lease } = status;
  for (const event of typedAndSent()) chrome.emit(event);
  const suggested = await result<{ steps: { action: string }[] }>("session.suggestions", {
    sessionId,
  });
  expect(suggested.steps.map(({ action }) => action)).toEqual(["fill", "click"]);
  const step = { id: "sent", assertion: "visible", target: { testId: "send" } };
  await result("flow.addAssertion", { sessionId, step }, lease);
  await result("session.stop", { sessionId }, lease);
  const saved = await result<{ flowId: string; revision: string }>("flow.finalize", { sessionId });
  const stored = await result<{ flow: { steps: { action?: string }[] } }>("flow.get", {
    flowId: saved.flowId,
  });
  expect(stored.flow.steps).toHaveLength(3);
  const renamed = { ...stored.flow, name: "Send the form" };
  const resaved = await result<{ revision: string }>("flow.save", { flow: renamed });
  expect(resaved.revision).not.toBe(saved.revision);
  const { runId } = await result<{ runId: string }>("flow.replay", { flowId: saved.flowId });
  expect((await call("run.summary", { runId })).error?.code).toBe("conflict");
  chrome.release();
  await expect.poll(async () => (await call("run.summary", { runId })).ok).toBe(true);
  const summary = await result<{ status: string }>("run.summary", { runId });
  expect(summary.status).toBe("passed");
  expect(chrome.writes).toEqual(["fill", "click"]);
  const page = await result<{ events: unknown[] }>("run.queryEvents", { runId, limit: 2 });
  expect(page).toMatchObject({ nextCursor: "2" });
  const types = new Set(events.pushed.map(({ type }) => type));
  expect([...types].toSorted()).toEqual([
    "run.finished",
    "run.step",
    "session.event",
    "session.status",
  ]);
  events.close();
});

test("pause, resume, and handoff change the session's status", async () => {
  type Status = { sessionId: string; state: string; control: string; lease?: Lease };
  const { sessionId, lease } = await result<Status>("session.start", {});
  const mode = "pauseStepCreation";
  expect((await call("session.pause", { sessionId, mode })).error?.code).toBe("stale-lease");
  expect((await result<Status>("session.pause", { sessionId, mode }, lease)).state).toBe("paused");
  const resumed = await result<Status>("session.resume", { sessionId, mode }, lease);
  expect(resumed.state).toBe("recording");
  expect((await call("session.handoff", { sessionId, to: "agent" })).error?.code).toBe(
    "stale-lease",
  );
  const toAgent = await result<Status>("session.handoff", { sessionId, to: "agent" }, lease);
  expect(toAgent).toMatchObject({ control: "agent", lease: { holderId: "agent" } });
  const back = await result<Status>("session.handoff", { sessionId, to: "manual" });
  expect(back).toMatchObject({ control: "manual", lease: { holderId: "person" } });
  const picking = await result("picker.start", { sessionId }, back.lease);
  expect(picking).toEqual({ sessionId, picking: true });
  const events = await subscribe();
  chrome.pick(SEND_TARGET);
  await expect.poll(() => events.pushed.length).toBe(1);
  expect(events.pushed[0]).toMatchObject({ type: "picker.picked", sessionId, target: SEND_TARGET });
  events.close();
});

test("flow.import stores a flow file's content and flow.list lists it", async () => {
  const flow = {
    schemaVersion: 1,
    id: "imported",
    name: "Imported",
    steps: [{ id: "open", action: "navigate", url: "http://127.0.0.1:4600/" }],
  };
  const imported = await result<{ flowId: string }>("flow.import", { flow });
  expect(imported.flowId).toBe("imported");
  const listed = await result<{ flows: { id: string }[] }>("flow.list", {});
  expect(listed.flows.map(({ id }) => id)).toEqual(["imported"]);
  expect((await call("flow.get", { flowId: "missing" })).error?.code).toBe("not-found");
});
