import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { bootstrap, startBootstrap } from "@/diagnostics/bootstrap";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const REFUSED = "The address carries no #token=<lowercase v4 uuid>.";

function dependencies(hash: string, reply: unknown = { ok: true }) {
  return {
    hash,
    adopt: vi.fn(async (_token: string) => {}),
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
    expect(await bootstrap(deps)).toEqual({ ok: true, token: TOKEN });
    expect(deps.adopt).toHaveBeenCalledWith(TOKEN);
    expect(deps.send).toHaveBeenCalledWith({ type: "POC_PUBLISH_PRESENCE" });
    const [adopted] = deps.adopt.mock.invocationCallOrder;
    const [sent] = deps.send.mock.invocationCallOrder;
    expect(adopted).toBeLessThan(sent ?? 0);
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

describe("startBootstrap", () => {
  test("keeps the token in session storage, asks the background, and shows the result", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const shown = { textContent: "" };

    await startBootstrap(pageWith(`#token=${TOKEN}`, shown));

    expect(await pocPresenceStore().boot()).toBe(TOKEN);
    expect(send).toHaveBeenCalledWith({ type: "POC_PUBLISH_PRESENCE" });
    expect(JSON.parse(shown.textContent)).toEqual({ ok: true, token: TOKEN });
  });

  test("leaves the boot alone for a refused fragment, with no result element", async () => {
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    await fakeBrowser.storage.session.set({ pocBoot: "99999999-9999-4999-8999-999999999999" });

    await startBootstrap(pageWith("#token=nope", null));

    expect(await pocPresenceStore().boot()).toBe("99999999-9999-4999-8999-999999999999");
    expect(send).not.toHaveBeenCalled();
  });
});
