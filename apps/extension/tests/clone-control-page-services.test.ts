import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { cloneControlServices } from "@/onboarding/clone-control-page-services";
import { POLL_MS } from "@/onboarding/clone-control-service";
import type { CloneControl, CloneControlSnapshot } from "@/onboarding/clone-control-service";
import { POC_READ_FILE } from "@/p2p/file-url-read";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { MASTER, MASTER_KEY, roleRepository } from "./role-fixture";

const W1 = "11111111-1111-4111-8111-111111111111";
const ROOT = "/Users/me/Downloads";
const LAB = `file://${ROOT}/RECnRun/poc/lab`;
const CLONES_URL = `${LAB}/control/clones.json`;
const REGISTRY_URL = `${LAB}/registry.json`;
const clones = JSON.stringify({
  clones: [{ name: "w1", instanceId: W1, state: "closed", mode: "headless", boot: "" }],
  updatedAt: 1_800_000_000_000,
});

/** What the background answers: a file's text by URL (absent: unreadable), or a fixed reply. */
function background(files: Record<string, string> = {}, reply: unknown = { ok: true }) {
  const asked: string[] = [];
  const sent: unknown[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (message: {
    type: string;
    url?: string;
  }) => {
    if (message.type !== POC_READ_FILE) {
      sent.push(message);
      return reply;
    }
    asked.push(message.url ?? "");
    const text = files[message.url ?? ""];
    return text === undefined
      ? { ok: false, error: { name: "TypeError", message: "Failed to fetch" } }
      : { ok: true, status: 0, text };
  }) as never);
  return { asked, sent };
}

function watch(control: CloneControl = cloneControlServices()) {
  const seen: CloneControlSnapshot[] = [];
  const stop = control.watch((snapshot) => seen.push(snapshot));
  return { stop, last: () => seen.at(-1) };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cloneControlServices", () => {
  test("is the master only with the master record", async () => {
    expect(await cloneControlServices().isMaster()).toBe(false);
    await roleRepository.write({ role: "master", profileId: MASTER, identity: MASTER_KEY });
    expect(await cloneControlServices().isMaster()).toBe(true);
  });

  test("reads nothing until Chrome reported the Downloads root", async () => {
    const { asked } = background();
    const { last, stop } = watch();
    await vi.waitFor(() => expect(last()).toBeDefined());
    expect(asked).toEqual([]);
    expect(last()?.clones).toEqual([]);
    stop();
  });

  test("lists the clones of the default namespace with the registry beside them", async () => {
    await pocPresenceStore().root.write(ROOT);
    const { asked } = background({ [CLONES_URL]: clones });
    const { last, stop } = watch();
    await vi.waitFor(() => expect(last()?.clones).toHaveLength(1));
    expect(asked.sort()).toEqual([CLONES_URL, REGISTRY_URL].sort());
    expect(last()?.clones[0]).toMatchObject({ instanceId: W1, linked: false });
    stop();
  });

  test("falls back to the default namespace when the stored one is not a namespace", async () => {
    await pocPresenceStore().root.write(ROOT);
    await pocPresenceStore().setNamespace("../Evil");
    const { asked } = background();
    const { stop } = watch();
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked).toContain(CLONES_URL);
    stop();
  });

  test("sends the request with a fresh id and reads its status on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await pocPresenceStore().root.write(ROOT);
    await pocPresenceStore().setNamespace("e9-lab");
    const { asked, sent } = background();
    const control = cloneControlServices();
    const { last, stop } = watch(control);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    await control.ask(W1, "open-headless");
    const requestId = last()?.pending?.requestId ?? "";
    expect(sent).toEqual([
      { type: "POC_CLONE_CONTROL", choice: { requestId, action: "open-headless", instanceId: W1 } },
    ]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() =>
      expect(asked).toContain(`file://${ROOT}/RECnRun/poc/e9-lab/control/${requestId}/status.json`),
    );
    stop();
    const polls = asked.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(asked).toHaveLength(polls);
  });

  test("shows why the background refused to write the request", async () => {
    background({}, { ok: false, error: "Only the master controls clones." });
    const control = cloneControlServices();
    const { last, stop } = watch(control);
    await control.ask(W1, "close");
    expect(last()).toMatchObject({
      pending: undefined,
      failure: "Only the master controls clones.",
    });
    stop();
  });
});
