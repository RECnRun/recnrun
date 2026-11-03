import { expect, test } from "vite-plus/test";
import { createCdpAdapter } from "../src/index.ts";
import { shareChrome } from "../src/shared-chrome.ts";
import { FakeBrowser } from "./fake-browser.ts";
import { now, page } from "./fake-cdp.ts";
import { ChromeChannel } from "./fake-hub-channel.ts";

const ONE = "ws://127.0.0.1:9222/devtools/browser/one";
const TWO = "ws://127.0.0.1:9333/devtools/browser/two";

function setup() {
  const channels: ChromeChannel[] = [];
  const browsers: FakeBrowser[] = [];
  const opened: string[] = [];
  const connected: string[] = [];
  const shared = shareChrome({
    openChannel: (endpoint) => {
      opened.push(endpoint);
      const channel = new ChromeChannel();
      channels.push(channel);
      return Promise.resolve(channel);
    },
    connectBrowser: (endpoint) => {
      connected.push(endpoint);
      const browser = new FakeBrowser();
      browsers.push(browser);
      return Promise.resolve(browser.asBrowser());
    },
  });
  return { shared, channels, browsers, opened, connected };
}

const targetIds = (reply: unknown) =>
  (reply as { targetInfos: { targetId: string }[] }).targetInfos.map(({ targetId }) => targetId);

test("lanes of one Chrome ride one socket; another Chrome gets its own", async () => {
  const { shared, channels, opened } = setup();
  const first = await shared.lane(ONE);
  const second = await shared.lane(ONE);
  await shared.lane(TWO);
  expect(opened).toEqual([ONE, TWO]);
  await first.send("Target.getTargets");
  await second.send("Target.getTargets");
  expect(channels[0]?.methods("L1")).toEqual(["Target.getTargets"]);
  expect(channels[0]?.methods("L2")).toEqual(["Target.getTargets"]);
  expect(channels[1]?.sent).toEqual([{ method: "Target.attachToBrowserTarget" }]);
});

test("links of one Chrome ride one Playwright connection, which outlives them", async () => {
  const { shared, browsers, connected } = setup();
  const first = await shared.transport.open(ONE);
  const second = await shared.transport.open(ONE);
  expect(connected).toEqual([ONE]);
  await first.close();
  expect(browsers[0]?.closed).toBe(false);
  expect(browsers[0]?.detached).toBe(1);
  await second.send("Browser.getVersion");
  expect(browsers[0]?.calls).toContain("browser Browser.getVersion");
  await shared.close();
  expect(browsers[0]?.closed).toBe(true);
});

test("a closed link no longer hears the connection drop; a live one does", async () => {
  const { shared, browsers } = setup();
  const first = await shared.transport.open(ONE);
  const second = await shared.transport.open(ONE);
  const dropped = { first: 0, second: 0 };
  first.onDisconnected(() => (dropped.first += 1));
  second.onDisconnected(() => (dropped.second += 1));
  await first.close();
  browsers[0]?.disconnect();
  expect(dropped).toEqual({ first: 0, second: 1 });
});

test("a socket or a connection that was lost is opened again on the next use", async () => {
  const { shared, channels, browsers, opened, connected } = setup();
  await shared.lane(ONE);
  await shared.transport.open(ONE);
  channels[0]?.lose();
  browsers[0]?.disconnect();
  await shared.lane(ONE);
  await shared.transport.open(ONE);
  expect(opened).toEqual([ONE, ONE]);
  expect(connected).toEqual([ONE, ONE]);
  expect(channels[1]?.sent).toEqual([{ method: "Target.attachToBrowserTarget" }]);
});

test("closing the share closes every socket and connection and refuses new ones", async () => {
  const { shared, channels, browsers } = setup();
  await shared.lane(ONE);
  await shared.transport.open(TWO);
  await shared.close();
  expect(channels.map(({ closed }) => closed)).toEqual([true]);
  expect(browsers.map(({ closed }) => closed)).toEqual([true]);
  await expect(shared.lane(ONE)).rejects.toThrow(/closed/);
  await expect(shared.transport.open(ONE)).rejects.toThrow(/closed/);
});

test("the preflight reports the pages other debuggers hold, never ours or Playwright's", async () => {
  const { shared, channels, opened } = setup();
  const lane = await shared.lane(ONE);
  const root = channels[0];
  if (!root) throw new Error("No socket was opened.");
  root.targets = [page("MINE", true), page("THEIRS", true), page("FREE")];
  root.attachOn("L1", "S-MINE", "MINE");
  expect(targetIds(await shared.transport.preflightTargets(ONE))).toEqual(["THEIRS", "FREE"]);
  expect(opened).toEqual([ONE]);
  expect(root.sent.at(-1)).toEqual({ method: "Target.getTargets" });
  // Once Playwright holds this Chrome, every page reads attached; none of it is contested.
  await shared.transport.open(ONE);
  expect(targetIds(await shared.transport.preflightTargets(ONE))).toEqual([]);
  lane.close();
});

test("each adapter over the shared Chrome starts with tabs of its own", async () => {
  const { shared, browsers, connected } = setup();
  const deps = {
    transport: shared.transport,
    openChannel: (endpoint: string) => shared.lane(endpoint),
    now,
  };
  const first = createCdpAdapter(deps);
  await first.connect(ONE);
  const navigate = { kind: "navigate", url: "http://127.0.0.1:4600/a" } as const;
  expect(await first.act(navigate, { timeoutMs: 500 })).toEqual({ status: "done" });
  expect(await first.tabs({ timeoutMs: 500 })).toMatchObject({ current: 0 });
  await first.disconnect();
  const second = createCdpAdapter(deps);
  await second.connect(ONE);
  expect(await second.tabs({ timeoutMs: 500 })).toEqual({ tabs: [], current: null });
  expect(connected).toEqual([ONE]);
  // The earlier run's tab is still Chrome's, not the new run's.
  expect(browsers[0]).toMatchObject({ closed: false, pages: [expect.anything()] });
  await second.disconnect();
  await shared.close();
  expect(browsers[0]?.closed).toBe(true);
});
