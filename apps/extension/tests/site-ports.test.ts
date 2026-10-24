import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { holdSitePorts } from "@/dashboard/site-ports";
import { SITE_PORT } from "@/messaging/site-port";

beforeEach(() => {
  fakeBrowser.reset();
});

/** A connecting port that records whether the dashboard watches it drop. */
function connecting(name: string) {
  const onDrop = vi.fn();
  const port = { name, onDisconnect: { addListener: onDrop } } as unknown as Browser.runtime.Port;
  return { port, onDrop };
}

test("the dashboard frame accepts only site tab ports, and lets each go once it drops", () => {
  // fakeBrowser implements no in-memory runtime.onConnect.
  const add = vi.spyOn(fakeBrowser.runtime.onConnect, "addListener").mockImplementation(() => {});
  holdSitePorts();
  const [[accept] = []] = add.mock.calls;
  const site = connecting(SITE_PORT);
  const other = connecting("another");
  accept?.(site.port);
  accept?.(other.port);
  expect(site.onDrop).toHaveBeenCalledTimes(1);
  expect(other.onDrop).not.toHaveBeenCalled();
});
