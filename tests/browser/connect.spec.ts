import { createCdpAdapter } from "../../packages/adapter/src/index.ts";
import { CDP_PROBE_DOMAINS, type AdapterEvent } from "../../packages/protocol/src/index.ts";
import { openCdpClient } from "./fixtures/cdp-client.ts";
import { expect, test, type ChromeInstance } from "./fixtures/chrome.ts";
import { FIXTURE_ORIGIN } from "./fixtures/fixture-app.ts";

async function connected(chrome: ChromeInstance) {
  const adapter = createCdpAdapter();
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  const handshake = await adapter.connect(chrome.wsEndpoint, {
    source: { userDataDir: chrome.userDataDir },
  });
  return { adapter, events, handshake };
}

async function crash(chrome: ChromeInstance, events: AdapterEvent[]): Promise<void> {
  process.kill(chrome.pid, "SIGKILL");
  await expect
    .poll(() => events.map(({ type }) => type), { timeout: 10_000 })
    .toContain("connection.lost");
}

test("connects with a handshake, lists targets, and reports a lost Chrome", async ({ chrome }) => {
  const { adapter, events, handshake } = await connected(chrome);
  console.log(`Handshake with ${chrome.version}: ${JSON.stringify(handshake)}`);
  expect(handshake.endpoint).toBe(chrome.wsEndpoint);
  expect(handshake.version.product).toMatch(/^Chrome\/\d+\./);
  expect(handshake.domains.map(({ domain, status }) => [domain, status])).toEqual(
    CDP_PROBE_DOMAINS.map((domain) => [domain, "available"]),
  );

  const url = `${FIXTURE_ORIGIN}/routes/form`;
  const client = await openCdpClient(chrome.wsEndpoint);
  const { targetId } = await client.send("Target.createTarget", { url });
  client.close();
  await expect
    .poll(async () => (await adapter.listTargets()).find((t) => t.targetId === targetId)?.url)
    .toBe(url);
  expect(events).toEqual([]);

  await crash(chrome, events);
  expect(events).toEqual([
    {
      type: "connection.lost",
      seq: 1,
      at: expect.any(String),
      endpoint: chrome.wsEndpoint,
      gap: { reason: "connection-lost", startedAt: events[0]?.at },
    },
  ]);
  const outcome = await adapter.reconnect();
  console.log(`reconnect() with Chrome gone: ${JSON.stringify(outcome)}`);
  expect(outcome).toMatchObject({ ok: false, code: "endpoint-gone" });
  expect(outcome.ok || outcome.remedy).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
});

test("reconnects after a crash and flags a page another debugger holds", async ({ chrome }) => {
  const { adapter, events } = await connected(chrome);
  await crash(chrome, events);
  const relaunched = await chrome.relaunch();

  const debuggerClient = await openCdpClient(relaunched.wsEndpoint);
  const { targetInfos } = (await debuggerClient.send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const held = targetInfos.find(({ type }) => type === "page");
  if (!held) throw new Error("The relaunched Chrome has no page.");
  const { sessionId } = (await debuggerClient.send("Target.attachToTarget", {
    targetId: held.targetId,
    flatten: true,
  })) as { sessionId: string };

  const outcome = await adapter.reconnect();
  console.log(`reconnect() after relaunch: ${JSON.stringify(outcome)}`);
  expect(outcome).toMatchObject({ ok: true, handshake: { endpoint: relaunched.wsEndpoint } });
  expect(events.slice(1)).toEqual([
    {
      type: "control.contested",
      seq: 2,
      at: expect.any(String),
      endpoint: relaunched.wsEndpoint,
      targetId: held.targetId,
      url: held.url,
      signal: "attached-before-connect",
    },
  ]);
  // Both clients keep working: CDP serves several debuggers on one target.
  const evaluated = await debuggerClient.send(
    "Runtime.evaluate",
    { expression: "6 * 7", returnByValue: true },
    sessionId,
  );
  expect(evaluated).toMatchObject({ result: { value: 42 } });

  await adapter.disconnect();
  debuggerClient.close();
  expect(events.map(({ type }) => type)).toEqual(["connection.lost", "control.contested"]);
});
