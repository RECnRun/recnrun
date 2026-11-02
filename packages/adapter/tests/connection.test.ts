import type { AdapterEvent, DiscoveryResult } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { connect, type ConnectOptions, type DiscoverOptions } from "../src/index.ts";
import { fakeChrome, fakeTransport, NOW, now, page, VERSION, type FakeChrome } from "./fake-cdp.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/one";
const NEXT_ENDPOINT = "ws://127.0.0.1:9333/devtools/browser/two";

function found(wsEndpoint = NEXT_ENDPOINT): DiscoveryResult {
  return {
    ok: true,
    wsEndpoint,
    userDataDir: "/p",
    source: "active-port-file",
    port: 9333,
    path: "/devtools/browser/two",
  };
}

function setup(chrome: FakeChrome = fakeChrome(), extra: Partial<ConnectOptions> = {}) {
  const fake = fakeTransport(chrome);
  const events: AdapterEvent[] = [];
  const discovered: DiscoverOptions[] = [];
  const options: ConnectOptions = {
    transport: fake.transport,
    onEvent: (event) => events.push(event),
    now,
    discover: (source) => {
      discovered.push(source);
      return Promise.resolve(found());
    },
    ...extra,
  };
  return { ...fake, chrome, events, discovered, options, open: () => connect(ENDPOINT, options) };
}

describe("handshake", () => {
  test("reads the version and probes every domain on its scope", async () => {
    const { open, links } = setup();
    const connection = await open();
    expect(connection.endpoint).toBe(ENDPOINT);
    expect(connection.handshake.version).toEqual(VERSION);
    expect(connection.handshake.domains).toEqual([
      { domain: "Target", scope: "browser", status: "available" },
      ...["Network", "Runtime", "Page", "Log", "DOMStorage", "Storage", "Fetch"].map((domain) => ({
        domain,
        scope: "page",
        status: "available",
      })),
    ]);
    expect(links[0]?.pageDetached).toBe(true);
  });

  test("a method Chrome does not know marks its domain unavailable", async () => {
    const chrome = fakeChrome({ missing: ["DOMStorage.disable"] });
    const connection = await setup(chrome).open();
    expect(connection.handshake.domains).toContainEqual({
      domain: "DOMStorage",
      scope: "page",
      status: "unavailable",
      reason: "Protocol error (DOMStorage.disable): 'DOMStorage.disable' wasn't found",
    });
  });

  test("a domain that answers with an error is still available", async () => {
    const chrome = fakeChrome({ failing: { "Storage.getStorageKey": "Target is not supported" } });
    const connection = await setup(chrome).open();
    expect(connection.handshake.domains).toContainEqual({
      domain: "Storage",
      scope: "page",
      status: "available",
      reason: "Protocol error (Storage.getStorageKey): Target is not supported",
    });
  });

  test("without an open page the page domains are unavailable", async () => {
    const connection = await setup(fakeChrome({ hasPage: false })).open();
    const page = connection.handshake.domains.filter((probe) => probe.scope === "page");
    expect(page).toHaveLength(7);
    for (const probe of page) {
      expect(probe).toMatchObject({ status: "unavailable", reason: "No page was open to probe." });
    }
  });

  test("rejects a version that is not one and closes the link", async () => {
    const { open, links } = setup(fakeChrome({ version: { product: "" } }));
    await expect(open()).rejects.toThrow();
    expect(links[0]?.closed).toBe(true);
  });

  test("fails when the endpoint does not answer", async () => {
    await expect(setup(fakeChrome({ refuse: true })).open()).rejects.toThrow(/ECONNREFUSED/);
  });
});

test("lists targets with the fields the protocol keeps", async () => {
  const connection = await setup(
    fakeChrome({ targets: [page("P1", true, "http://a.test/")] }),
  ).open();
  expect(await connection.listTargets()).toEqual([
    {
      targetId: "P1",
      type: "page",
      url: "http://a.test/",
      title: "",
      attached: true,
      browserContextId: "C1",
    },
  ]);
});

describe("contested control", () => {
  test("reports a page another client attached before the connection, and never detaches it", async () => {
    const targets = [
      page("P1", true, "http://a.test/"),
      page("P2", false),
      { ...page("W1", true), type: "service_worker" },
    ];
    const { open, events, links, preflights } = setup(fakeChrome({ targets }));
    await open();
    expect(preflights).toEqual([ENDPOINT]);
    expect(events).toEqual([
      {
        type: "control.contested",
        seq: 1,
        at: NOW,
        endpoint: ENDPOINT,
        targetId: "P1",
        url: "http://a.test/",
        signal: "attached-before-connect",
      },
    ]);
    expect(links[0]?.calls.some((call) => call.includes("detach"))).toBe(false);
  });
});

describe("connection loss", () => {
  test("emits connection.lost with a gap record", async () => {
    const { open, events, links } = setup();
    await open();
    links[0]?.drop();
    expect(events).toEqual([
      {
        type: "connection.lost",
        seq: 1,
        at: NOW,
        endpoint: ENDPOINT,
        gap: { reason: "connection-lost", startedAt: NOW },
      },
    ]);
  });

  test("the gap names the last sequence seen before the loss", async () => {
    const { open, events, links } = setup(fakeChrome({ targets: [page("P1", true)] }));
    await open();
    links[0]?.drop();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ type: "connection.lost", gap: { lastSeq: 1 } });
  });

  test("an intentional disconnect closes the link without a loss", async () => {
    const { open, events, links } = setup();
    const connection = await open();
    await connection.disconnect();
    expect(links[0]?.closed).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("reconnect", () => {
  test("is endpoint-gone without a DevToolsActivePort to come back to", async () => {
    const connection = await setup().open();
    const outcome = await connection.reconnect();
    expect(outcome).toMatchObject({ ok: false, code: "endpoint-gone" });
    expect(outcome.ok ? "" : outcome.remedy).toMatch(/userDataDir or activePortFile/);
  });

  test("is endpoint-gone while the file is stale, with discovery's remedy", async () => {
    const remedy = "Port 9222 is closed. Enable remote debugging and keep Chrome open.";
    const stale: DiscoveryResult = { ok: false, code: "stale-file", remedy, userDataDir: "/p" };
    const { open, discovered } = setup(fakeChrome(), {
      source: { userDataDir: "/p" },
      discover: (source) => {
        discovered.push(source);
        return Promise.resolve(stale);
      },
    });
    const connection = await open();
    expect(await connection.reconnect()).toEqual({ ok: false, code: "endpoint-gone", remedy });
    expect(discovered).toEqual([{ userDataDir: "/p" }]);
  });

  test("is endpoint-gone when the rediscovered endpoint does not answer", async () => {
    const context = setup(fakeChrome(), { source: { activePortFile: "/p/DevToolsActivePort" } });
    const connection = await context.open();
    context.chrome.refuse = true;
    const outcome = await connection.reconnect();
    expect(outcome).toMatchObject({ ok: false, code: "endpoint-gone" });
    expect(outcome.ok ? "" : outcome.remedy).toContain(NEXT_ENDPOINT);
    expect(context.discovered).toEqual([{ activePortFile: "/p/DevToolsActivePort" }]);
  });

  test("connects to the endpoint the same file names now and keeps the sequence", async () => {
    const context = setup(fakeChrome(), { source: { userDataDir: "/p" } });
    const connection = await context.open();
    context.links[0]?.drop();
    context.chrome.targets = [page("P9", true, "about:blank")];
    const outcome = await connection.reconnect();
    if (!outcome.ok) throw new Error(outcome.remedy);
    expect(outcome.connection.endpoint).toBe(NEXT_ENDPOINT);
    expect(context.events.map((event) => [event.type, event.seq, event.endpoint])).toEqual([
      ["connection.lost", 1, ENDPOINT],
      ["control.contested", 2, NEXT_ENDPOINT],
    ]);
    context.links[1]?.drop();
    expect(context.events[2]).toMatchObject({
      type: "connection.lost",
      seq: 3,
      gap: { lastSeq: 2 },
    });
  });

  test("an explicit source wins, and a live link is closed first without a loss", async () => {
    const context = setup();
    const connection = await context.open();
    const outcome = await connection.reconnect({ userDataDir: "/q" });
    expect(outcome.ok).toBe(true);
    expect(context.discovered).toEqual([{ userDataDir: "/q" }]);
    expect(context.links[0]?.closed).toBe(true);
    expect(context.events).toEqual([]);
  });
});
