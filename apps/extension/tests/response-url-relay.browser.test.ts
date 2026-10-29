import { afterEach, expect, test, vi } from "vite-plus/test";
import { PORT_OFFER_EVENT, RELAY_READY_EVENT } from "@/messaging/response-url-protocol";
import { receiveUrls } from "@/origin/response-url-page";
import { acceptPort, relayUrls, startResponseUrlRelay } from "@/origin/response-url-relay";

const browser = vi.hoisted(() => ({
  runtime: { sendMessage: vi.fn() },
  extension: { inIncognitoContext: true },
}));

vi.mock("wxt/browser", () => ({ browser }));

const PAIRS = [["https://app.example/a", "https://app.example/a?via=redirect"]];

afterEach(() => {
  vi.restoreAllMocks();
  browser.runtime.sendMessage.mockReset();
  browser.extension.inIncognitoContext = true;
});

/** The data the relay posts on a port it was handed, as the page script receives it. */
async function relayed(ask: () => Promise<unknown>): Promise<unknown> {
  const channel = new MessageChannel();
  const received = new Promise((resolve) => {
    channel.port1.onmessage = ({ data }) => resolve(data);
  });
  await relayUrls(channel.port2, ask);
  return received;
}

test("hands the page script the URLs the background answers", async () => {
  expect(await relayed(async () => ({ ok: true, result: PAIRS }))).toEqual(PAIRS);
});

test("hands none on a refusal, a reply of another shape, or no reply", async () => {
  expect(await relayed(async () => ({ ok: false, error: "No." }))).toEqual([]);
  expect(await relayed(async () => ({ ok: true, result: [["only one"]] }))).toEqual([]);
  expect(await relayed(async () => "pairs")).toEqual([]);
  expect(
    await relayed(async () => {
      throw new Error("Receiving end does not exist.");
    }),
  ).toEqual([]);
});

test("takes the port whichever script runs first, and only the first offer", async () => {
  for (const relayFirst of [true, false]) {
    const target = new EventTarget();
    const ports: MessagePort[] = [];
    if (relayFirst) acceptPort(target, (port) => ports.push(port));
    const urls = receiveUrls(target, 1_000);
    if (!relayFirst) acceptPort(target, (port) => ports.push(port));
    expect(ports, `relay first: ${relayFirst}`).toHaveLength(1);
    ports[0]?.postMessage(PAIRS);
    expect([...(await urls)]).toEqual(PAIRS);

    // Neither listens any more: a later offer or announcement reaches nobody.
    const later = new MessageEvent(PORT_OFFER_EVENT, {
      ports: [new MessageChannel().port1],
      cancelable: true,
    });
    expect(target.dispatchEvent(later)).toBe(true);
    target.dispatchEvent(new Event(RELAY_READY_EVENT));
    expect(ports).toHaveLength(1);
  }
});

test("ignores an offer without a port", () => {
  const target = new EventTarget();
  const ports: MessagePort[] = [];
  acceptPort(target, (port) => ports.push(port));
  const bare = new Event(PORT_OFFER_EVENT, { cancelable: true });
  expect(target.dispatchEvent(bare)).toBe(true);
  expect(ports).toEqual([]);
});

test("asks the background for its frame's URLs on the document", async () => {
  browser.runtime.sendMessage.mockResolvedValue({ ok: true, result: PAIRS });
  const urls = receiveUrls(document, 1_000);
  startResponseUrlRelay();
  expect([...(await urls)]).toEqual(PAIRS);
  expect(browser.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "response-urls" });
});

test("in a normal window, hands none at once without asking the background", async () => {
  browser.extension.inIncognitoContext = false;
  browser.runtime.sendMessage.mockResolvedValue({ ok: true, result: PAIRS });
  const urls = receiveUrls(document, 1_000);
  startResponseUrlRelay();
  expect([...(await urls)]).toEqual([]);
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
});
