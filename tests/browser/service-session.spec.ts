import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import type { Lease, ServiceMessage } from "../../packages/protocol/src/index.ts";
import type { ChromeInstance } from "./fixtures/chrome.ts";
import { counters, expect, FIXTURE_ORIGIN, test, waitReady } from "./fixtures/fixture-app.ts";

type Envelope = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
type Status = { sessionId: string; state: string; lease?: Lease };

/** A service on a temporary home whose default profile is the test's Chrome. */
async function serviceFor(chrome: ChromeInstance) {
  const home = await mkdtemp(join(tmpdir(), "recnrun-service-session-"));
  const started = await startService({
    home,
    discover: async () => ({
      ok: true,
      wsEndpoint: chrome.wsEndpoint,
      userDataDir: chrome.userDataDir,
      source: "active-port-file",
      port: chrome.port,
      path: chrome.wsPath,
    }),
  });
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  const service = started.service;
  const stop = async () => {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  };
  return { service, stop };
}

async function call(service: RunningService, command: string, params: unknown, lease?: Lease) {
  const fence = lease && { leaseId: lease.leaseId, fencingToken: lease.fencingToken };
  const response = await fetch(`http://127.0.0.1:${service.port}/api`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: command, command, params, ...(fence && { lease: fence }) }),
  });
  return (await response.json()) as Envelope;
}

async function result<T>(service: RunningService, command: string, params: unknown, lease?: Lease) {
  const envelope = await call(service, command, params, lease);
  expect(envelope, `${command} answered ${envelope.error?.code ?? "ok"}`).toMatchObject({
    ok: true,
  });
  return envelope.result as T;
}

async function targetIdOf(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  await session.detach();
  return targetInfo.targetId;
}

/** The Playwright page of the tab the service opened for its session. */
async function pageOf(context: BrowserContext, targetId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const page of context.pages()) if ((await targetIdOf(page)) === targetId) found = page;
      return found !== undefined;
    })
    .toBe(true);
  return found as Page;
}

/** Every message the service pushes over `/ws` after `events.subscribe`. */
async function subscribe(service: RunningService) {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws?token=${service.token}`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const pushed: ServiceMessage[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (!("requestId" in message)) pushed.push(message as ServiceMessage);
  });
  socket.send(JSON.stringify({ requestId: "sub", command: "events.subscribe", params: {} }));
  return { pushed, close: () => socket.close() };
}

test("a session records the form, finalizes a flow that replays, and picks without clicking", async ({
  app,
  chrome,
}) => {
  const { service, stop } = await serviceFor(chrome);
  try {
    const status = await result<Status>(service, "session.start", {});
    const page = await pageOf(app.context, status.lease?.targetId ?? "");
    await page.goto(`${FIXTURE_ORIGIN}/routes/form`);
    await waitReady(page, "form");
    await page.getByTestId("name").fill("Ada");
    await page.getByTestId("submit").click();
    await expect.poll(async () => (await counters(page)).submits).toBe(1);
    const suggested = (steps: { action: string }[]) => steps.map(({ action }) => action);
    await expect
      .poll(async () => {
        const { steps } = await result<{ steps: { action: string }[] }>(
          service,
          "session.suggestions",
          { sessionId: status.sessionId },
        );
        return suggested(steps);
      })
      .toEqual(expect.arrayContaining(["fill", "click"]));
    await result(service, "session.stop", { sessionId: status.sessionId }, status.lease);
    const { flowId } = await result<{ flowId: string }>(service, "flow.finalize", {
      sessionId: status.sessionId,
    });
    const { flow } = await result<{ flow: { steps: { action?: string }[] } }>(service, "flow.get", {
      flowId,
    });
    expect(flow.steps.map(({ action }) => action)).toEqual(
      expect.arrayContaining(["fill", "click"]),
    );
    const { runId } = await result<{ runId: string }>(service, "flow.replay", { flowId });
    await expect
      .poll(async () => (await call(service, "run.summary", { runId })).ok, { timeout: 30_000 })
      .toBe(true);
    const summary = await result<{ status: string }>(service, "run.summary", { runId });
    expect(summary.status).toBe("passed");

    const picking = await result<Status>(service, "session.start", {});
    const target = await pageOf(app.context, picking.lease?.targetId ?? "");
    await target.goto(`${FIXTURE_ORIGIN}/routes/form`);
    await waitReady(target, "form");
    const events = await subscribe(service);
    await result(service, "picker.start", { sessionId: picking.sessionId }, picking.lease);
    const box = await target.getByTestId("submit").boundingBox();
    if (!box) throw new Error("The submit button has no box.");
    await target.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const picked = () => events.pushed.find(({ type }) => type === "picker.picked");
    await expect.poll(() => picked() !== undefined).toBe(true);
    expect(picked()).toMatchObject({
      sessionId: picking.sessionId,
      target: { testId: "submit" },
      locators: { locators: expect.arrayContaining([{ strategy: "testId", value: "submit" }]) },
    });
    expect((await counters(target)).clicks ?? 0).toBe(0);
    events.close();
  } finally {
    await stop();
  }
});
