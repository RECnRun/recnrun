import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { RouteAEngine } from "@/background/route-a/engine";
import { ROUTE_A_GLOBAL } from "@/background/route-a/expose";
import { GET_SELF, LOADED_KEY, startBackground } from "@/background/start";

const self = {
  id: fakeBrowser.runtime.id,
  name: "RECnRun Isolator (POC)",
  installType: "development",
};

function send(message: unknown, senderId: string = fakeBrowser.runtime.id) {
  const sendResponse = vi.fn();
  const listeners = fakeBrowser.runtime.onMessage.trigger(message, { id: senderId }, sendResponse);
  return { sendResponse, listeners };
}

describe("startBackground", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.management.getSelf = vi.fn(async () => self) as never;
    fakeBrowser.runtime.getManifest = () => ({
      manifest_version: 3,
      name: self.name,
      version: "0.1.0",
    });
    startBackground();
  });

  test("records that it loaded, with its id and version, on install", async () => {
    await fakeBrowser.runtime.onInstalled.trigger({ reason: "install" });
    await vi.waitFor(async () =>
      expect(await fakeBrowser.storage.session.get(LOADED_KEY)).toEqual({
        [LOADED_KEY]: {
          loaded: true,
          id: fakeBrowser.runtime.id,
          version: "0.1.0",
        },
      }),
    );
  });

  test("records that it loaded on browser startup", async () => {
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(async () =>
      expect(await fakeBrowser.storage.session.get(LOADED_KEY)).toHaveProperty(
        `${LOADED_KEY}.loaded`,
        true,
      ),
    );
  });

  test("answers its own getSelf request with management.getSelf", async () => {
    const { sendResponse, listeners } = send({ type: GET_SELF });
    expect(await listeners).toEqual([true]);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(self));
  });

  test("ignores other extensions and unknown messages", async () => {
    expect(await send({ type: GET_SELF }, "another-extension").listeners).toEqual([false]);
    expect(await send({ type: "unknown" }).listeners).toEqual([false]);
    expect(await send("getSelf").listeners).toEqual([false]);
    expect(fakeBrowser.management.getSelf).not.toHaveBeenCalled();
  });

  test("exposes Route A to the harness", () => {
    expect(Reflect.get(globalThis, ROUTE_A_GLOBAL)).toBeInstanceOf(RouteAEngine);
  });
});
