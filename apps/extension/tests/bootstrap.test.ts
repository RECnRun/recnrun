import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { bootstrap, startBootstrap } from "@/diagnostics/bootstrap";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { pocTemplateStore } from "@/storage/poc-template-repository";

// Template mode discards the identity key and certificate, which live in IndexedDB.
vi.mock("@/p2p/p2p-database", () => import("./memory-p2p-database"));

const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const REFUSED = "The address carries no #token=<lowercase v4 uuid>.";
const TEMPLATE_REFUSED =
  "The address carries no #template=<lowercase v4 uuid>&setting=base-v<number>.";
const TEMPLATE = `#template=${TOKEN}&setting=base-v1`;

function dependencies(hash: string, reply: unknown = { ok: true }) {
  return {
    hash,
    adopt: vi.fn(async (_token: string) => {}),
    enterTemplate: vi.fn(async (_setting: string) => {}),
    send: vi.fn(async (_message: unknown) => reply),
  };
}

/** A bootstrap page at `hash`, with or without its result element. */
function pageWith(hash: string, element: { textContent: string } | null) {
  const page = { location: { hash }, document: { getElementById: vi.fn(() => element) } };
  return page as unknown as Window & typeof globalThis;
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootstrap", () => {
  test("stores the launcher's token as this session's boot, then asks for a presence now", async () => {
    const deps = dependencies(`#token=${TOKEN}`);
    expect(await bootstrap(deps)).toEqual({ ok: true, token: TOKEN, acked: true });
    expect(deps.adopt).toHaveBeenCalledWith(TOKEN);
    expect(deps.send).toHaveBeenNthCalledWith(1, { type: "POC_PUBLISH_PRESENCE" });
    const [adopted] = deps.adopt.mock.invocationCallOrder;
    const [presence, ack] = deps.send.mock.invocationCallOrder;
    expect(adopted).toBeLessThan(presence ?? 0);
    expect(presence).toBeLessThan(ack ?? 0);
  });

  test("then asks for the ack of the attempt's token and says it was written", async () => {
    const deps = dependencies(`#token=${TOKEN}`);
    expect(await bootstrap(deps)).toMatchObject({ acked: true });
    expect(deps.send).toHaveBeenNthCalledWith(2, { type: "POC_LAUNCHER_ACK", token: TOKEN });
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  test("keeps the presence when the ack fails, and says it was not written", async () => {
    const replies = [{ ok: true }, { ok: false, error: "No presence has been published yet." }];
    const deps = { ...dependencies(`#token=${TOKEN}`), send: vi.fn(async () => replies.shift()) };
    expect(await bootstrap(deps)).toEqual({
      ok: true,
      token: TOKEN,
      acked: false,
      error: "No presence has been published yet.",
    });
  });

  test("asks for no ack when the presence failed", async () => {
    const deps = dependencies(`#token=${TOKEN}`, { ok: false, error: "Invalid filename" });
    expect(await bootstrap(deps)).toEqual({ ok: false, error: "Invalid filename" });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  test.each([
    "",
    "#",
    `#token=${TOKEN.toUpperCase()}`,
    `#token=${TOKEN}&next=1`,
    `#token=${TOKEN} `,
    "#token=0f8b6a3e-2c1d-1e5f-9a7b-1c2d3e4f5a6b",
    "#token=0f8b6a3e-2c1d-4e5f-7a7b-1c2d3e4f5a6b",
    `#boot=${TOKEN}`,
    `#setting=base-v1&template=${TOKEN}`,
    `#token=${TOKEN}#token=${TOKEN}`,
  ])("refuses the fragment %j, storing and sending nothing", async (hash) => {
    const deps = dependencies(hash);
    expect(await bootstrap(deps)).toEqual({ ok: false, error: REFUSED });
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  test("passes the background's failure through, and names a malformed reply", async () => {
    const failed = dependencies(`#token=${TOKEN}`, { ok: false, error: "Invalid filename" });
    expect(await bootstrap(failed)).toEqual({ ok: false, error: "Invalid filename" });
    const malformed = dependencies(`#token=${TOKEN}`, "garbage");
    expect(await bootstrap(malformed)).toEqual({
      ok: false,
      error: "The background sent a malformed reply to POC_PUBLISH_PRESENCE.",
    });
  });
});

describe("bootstrap of a template base", () => {
  test("enters template mode, then acks with the template fields, adopting no boot and asking for no presence", async () => {
    const deps = dependencies(TEMPLATE);
    expect(await bootstrap(deps)).toEqual({
      ok: true,
      token: TOKEN,
      template: true,
      setting: "base-v1",
      acked: true,
    });
    expect(deps.enterTemplate).toHaveBeenCalledWith("base-v1");
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith({
      type: "POC_LAUNCHER_ACK",
      token: TOKEN,
      template: true,
      setting: "base-v1",
    });
    const [entered] = deps.enterTemplate.mock.invocationCallOrder;
    const [ack] = deps.send.mock.invocationCallOrder;
    expect(entered).toBeLessThan(ack ?? 0);
  });

  test("says the ack was not written, and sends nothing when template mode could not be stored", async () => {
    const failed = {
      ...dependencies(TEMPLATE),
      send: vi.fn(async () => ({ ok: false, error: "No presence has been published yet." })),
    };
    expect(await bootstrap(failed)).toEqual({
      ok: true,
      token: TOKEN,
      template: true,
      setting: "base-v1",
      acked: false,
      error: "No presence has been published yet.",
    });
    const unstored = dependencies(TEMPLATE);
    unstored.enterTemplate.mockRejectedValue(new Error("quota"));
    expect(await bootstrap(unstored)).toEqual({ ok: false, error: "quota" });
    expect(unstored.send).not.toHaveBeenCalled();
  });

  test.each([
    `#template=${TOKEN}`,
    `#template=${TOKEN}&setting=`,
    `#template=${TOKEN}&setting=base-v`,
    `#template=${TOKEN}&setting=base-v1x`,
    `#template=${TOKEN}&setting=Base-v1`,
    `#template=${TOKEN}&setting=../base-v1`,
    `#template=${TOKEN}&setting=base-v1&next=1`,
    `#template=${TOKEN}&setting=base-v1 `,
    `#template=${TOKEN.toUpperCase()}&setting=base-v1`,
    "#template=0f8b6a3e-2c1d-1e5f-9a7b-1c2d3e4f5a6b&setting=base-v1",
    `#template=${TOKEN}&setting=base-v1#token=${TOKEN}`,
  ])("refuses the fragment %j, storing and sending nothing", async (hash) => {
    const deps = dependencies(hash);
    expect(await bootstrap(deps)).toEqual({ ok: false, error: TEMPLATE_REFUSED });
    expect(deps.enterTemplate).not.toHaveBeenCalled();
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  test("keeps the token fragment as it was", async () => {
    const deps = dependencies(`#token=${TOKEN}`);
    expect(await bootstrap(deps)).toEqual({ ok: true, token: TOKEN, acked: true });
    expect(deps.enterTemplate).not.toHaveBeenCalled();
  });
});

describe("startBootstrap", () => {
  test("a template page stores the mode and setting, acks with them, and leaves the boot and presence alone", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const shown = { textContent: "" };

    await startBootstrap(pageWith(TEMPLATE, shown));

    expect(await pocTemplateStore().templateMode()).toBe(true);
    expect(await pocTemplateStore().setting()).toBe("base-v1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "POC_LAUNCHER_ACK",
      token: TOKEN,
      template: true,
      setting: "base-v1",
    });
    expect(await fakeBrowser.storage.session.get("pocBoot")).toEqual({});
    expect(JSON.parse(shown.textContent)).toMatchObject({ ok: true, template: true, acked: true });
  });

  test("keeps the token in session storage, asks the background, and shows the result", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const shown = { textContent: "" };

    await startBootstrap(pageWith(`#token=${TOKEN}`, shown));

    expect(await pocPresenceStore().boot()).toBe(TOKEN);
    expect(send).toHaveBeenCalledWith({ type: "POC_PUBLISH_PRESENCE" });
    expect(send).toHaveBeenCalledWith({ type: "POC_LAUNCHER_ACK", token: TOKEN });
    expect(JSON.parse(shown.textContent)).toEqual({ ok: true, token: TOKEN, acked: true });
  });

  test("a second attempt on the running session leaves the boot, yet still asks for its ack", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const later = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

    await startBootstrap(pageWith(`#token=${TOKEN}`, { textContent: "" }));
    await startBootstrap(pageWith(`#token=${later}`, { textContent: "" }));

    expect(await pocPresenceStore().boot()).toBe(TOKEN);
    expect(send).toHaveBeenCalledWith({ type: "POC_LAUNCHER_ACK", token: later });
  });

  test("leaves the boot alone for a refused fragment, with no result element", async () => {
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    await fakeBrowser.storage.session.set({ pocBoot: "99999999-9999-4999-8999-999999999999" });

    await startBootstrap(pageWith("#token=nope", null));

    expect(await pocPresenceStore().boot()).toBe("99999999-9999-4999-8999-999999999999");
    expect(send).not.toHaveBeenCalled();
  });
});
