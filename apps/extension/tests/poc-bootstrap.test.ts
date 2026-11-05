import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startedOutward } from "@/background/poc-bootstrap";
import type { DownloadsPort, WriterPort } from "@/background/downloads-publisher";
import { MASTER, MASTER_KEY, roleRepository } from "./role-fixture";
import { FINGERPRINT, ME } from "./fake-peer";
import { signAs } from "./test-identity";

const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const choice = { operationId: OP, basesDir: "/Users/me/Bases", baseName: "base-v1", clones: 2 };
const request = { type: "POC_PREPARE_WORKERS", op: "request", choice };

type Written = Parameters<DownloadsPort["download"]>[0];
type Listener = (
  message: unknown,
  sender: { id?: string; url?: string },
  reply: (answer: unknown) => void,
) => boolean;

const written: Written[] = [];

/** The listeners the bootstrap registers, in registration order: ack, failure, provision, prepare. */
function bootstrapped(presence: Awaited<ReturnType<Parameters<typeof startedOutward>[0]>>) {
  const listeners: Listener[] = [];
  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation((listener) => {
    listeners.push(listener as unknown as Listener);
  });
  const answer = startedOutward(async () => presence, { log: vi.fn(), sign: vi.fn() });
  return { listeners, answer };
}

const fakePresence = (identity: typeof STATEMENT | undefined) =>
  ({ identity: () => identity }) as unknown as Awaited<
    ReturnType<Parameters<typeof startedOutward>[0]>
  >;

async function ask(prepare: Listener | undefined) {
  const reply = vi.fn();
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL("/dashboard.html") };
  expect(prepare?.(request, sender, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalled());
  return reply.mock.calls[0]?.[0];
}

beforeEach(() => {
  fakeBrowser.reset();
  written.length = 0;
  Object.defineProperty(browser, "downloads", {
    configurable: true,
    value: {
      download: vi.fn(async (options: Written) => written.push(options)),
      search: vi.fn(async ({ id = 0 }: { id?: number }) => [
        { id, filename: "", state: "complete" },
      ]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    } satisfies WriterPort,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(browser, "downloads");
});

describe("startedOutward", () => {
  test("answers the presence the start made, and registers no listener without poc", async () => {
    const presence = fakePresence(STATEMENT);
    const add = vi.spyOn(browser.runtime.onMessage, "addListener");
    const answer = startedOutward(async () => presence, false);
    expect(await answer()).toBe(presence);
    expect(add).not.toHaveBeenCalled();
  });

  test("with poc, answers the ack, the provisioning and the prepare request", () => {
    expect(bootstrapped(fakePresence(STATEMENT)).listeners).toHaveLength(4);
  });

  test("refuses the prepare request of a profile that is not the master", async () => {
    const { listeners } = bootstrapped(fakePresence(STATEMENT));
    expect(await ask(listeners[3])).toEqual({
      ok: false,
      error: "Only the master prepares workers.",
    });
    expect(written).toEqual([]);
  });

  test("refuses a worker's prepare request: only the master record counts", async () => {
    await roleRepository.write({
      role: "worker",
      masterProfileId: MASTER,
      masterIdentity: MASTER_KEY,
      boundAt: 1,
      source: "pairing",
    });
    const { listeners } = bootstrapped(fakePresence(STATEMENT));
    expect(await ask(listeners[3])).toMatchObject({ ok: false });
    expect(written).toEqual([]);
  });

  test("the master writes the request under the identity of the latest presence", async () => {
    await roleRepository.write({ role: "master", profileId: MASTER, identity: MASTER_KEY });
    const { listeners } = bootstrapped(fakePresence(STATEMENT));
    expect(await ask(listeners[3])).toEqual({ ok: true });
    expect(written).toHaveLength(1);
    expect(written[0]?.filename).toBe(`RECnRun/poc/lab/ops/${OP}/request.json`);
    const body = decodeURIComponent((written[0]?.url ?? "").split(",").slice(1).join(","));
    expect(JSON.parse(body)).toMatchObject({ masterProfileId: MASTER, masterIdentity: STATEMENT });
  });

  test("the master has nothing to state before a presence was published", async () => {
    await roleRepository.write({ role: "master", profileId: MASTER, identity: MASTER_KEY });
    const { listeners } = bootstrapped(undefined);
    expect(await ask(listeners[3])).toEqual({
      ok: false,
      error: "No presence has been published yet.",
    });
    expect(written).toEqual([]);
  });
});
