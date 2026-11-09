import { describe, expect, test } from "vite-plus/test";
import { createFileSignal } from "./worker-extension/file-signal.js";
import { loadIdentity } from "./worker-extension/identity.js";
import { createLinkState } from "./worker-extension/link-state.js";
import type { LinkChange } from "./worker-extension/link-state.js";

/* Owner flow, task B: current.json → offer → answer download, and no file replaces a live link. */

const EXCHANGE = "file:///lab/roots/w1/exchange/";
const CONTEXT = { workspace: "ws", root: "w1", masterKey: {} };
const offerFor = (attempt: string) => ({
  attempt,
  root: "w1",
  nonce: `n-${attempt}`,
  sdp: "offer",
});

function harness(refusal: string | null = null) {
  const files = new Map<string, unknown>();
  const emitted: { name: string; body: unknown }[] = [];
  const logs: string[] = [];
  const changes: LinkChange[] = [];
  const connected: string[] = [];
  const link = createLinkState({ onChange: (change) => changes.push(change) });
  const publish = (attempt: string) => {
    files.set(`${EXCHANGE}offer-${attempt}.json`, offerFor(attempt));
    files.set(`${EXCHANGE}current.json`, { attempt, file: `offer-${attempt}.json` });
  };
  const signal = createFileSignal({
    exchangeUrl: EXCHANGE,
    context: CONTEXT,
    deps: {
      readJson: async (url) => files.get(url) ?? null,
      check: async () => refusal,
      link,
      connect: async (_sdp, attempt) => {
        connected.push(attempt);
        return `answer-sdp-${attempt}`;
      },
      bootId: async () => "boot-1",
      identity: loadIdentity({ readPk8: async () => null }),
      emit: async (name, body) => emitted.push({ name, body }),
      log: (text) => logs.push(text),
    },
  });
  return { signal, link, files, emitted, logs, changes, connected, publish };
}

describe("the file signal", () => {
  test("a published offer is answered once, as answer-<attempt>.json", async () => {
    const run = harness();
    run.publish("a1");
    await run.signal.tick();
    await run.signal.tick();
    expect(run.connected).toEqual(["a1"]);
    expect(run.emitted.map((entry) => entry.name)).toEqual(["answer-a1.json"]);
    expect(run.emitted[0]?.body).toMatchObject({ type: "answer", attempt: "a1", bootId: "boot-1" });
    expect(run.link.state()).toBe("connecting");
  });

  test("a new offer while linked is ignored and logged, and taken after the link is lost", async () => {
    const run = harness();
    run.publish("a1");
    await run.signal.tick();
    run.link.opened("a1");
    run.publish("a2");
    await run.signal.tick();
    expect(run.logs).toEqual(["offer ignored: linked"]);
    expect(run.connected).toEqual(["a1"]);
    run.link.lost("a1");
    run.publish("a3");
    await run.signal.tick();
    expect(run.connected).toEqual(["a1", "a3"]);
    expect(run.changes.map((change) => change.state)).toEqual([
      "connecting",
      "linked",
      "unlinked",
      "connecting",
    ]);
  });

  test("a refused offer is logged and never connects", async () => {
    const run = harness("BAD_SIGNATURE");
    run.publish("a1");
    await run.signal.tick();
    expect(run.logs).toEqual(["offer refused: BAD_SIGNATURE"]);
    expect(run.connected).toEqual([]);
    expect(run.link.state()).toBe("unlinked");
  });

  test("a pointer naming another file, or no pointer, does nothing", async () => {
    const run = harness();
    await run.signal.tick();
    run.files.set(`${EXCHANGE}current.json`, { attempt: "a1", file: "../policy.json" });
    await run.signal.tick();
    expect(run.connected).toEqual([]);
    expect(run.logs).toEqual([]);
  });
});
