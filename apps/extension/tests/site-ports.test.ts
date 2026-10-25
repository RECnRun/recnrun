import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { holdSitePorts } from "@/dashboard/site-ports";
import { SITE_PORT } from "@/messaging/site-port";

beforeEach(() => {
  fakeBrowser.reset();
});

/** A connecting port that the test drops, as Chrome does when its site tab closes or navigates. */
function connecting(name: string) {
  const drops: (() => void)[] = [];
  const port = {
    name,
    onDisconnect: { addListener: (listener: () => void) => drops.push(listener) },
  } as unknown as Browser.runtime.Port;
  return { port, drop: () => drops.forEach((listener) => listener()), watched: () => drops.length };
}

test("the dashboard frame holds only site tab ports, and lets each go once it drops", () => {
  // fakeBrowser implements no in-memory runtime.onConnect.
  const add = vi.spyOn(fakeBrowser.runtime.onConnect, "addListener").mockImplementation(() => {});
  const held = holdSitePorts();
  const [[accept] = []] = add.mock.calls;
  const site = connecting(SITE_PORT);
  const other = connecting("another");
  accept?.(site.port);
  accept?.(other.port);
  expect([...held]).toEqual([site.port]);
  expect(other.watched()).toBe(0);

  site.drop();
  expect(held.size).toBe(0);
});
