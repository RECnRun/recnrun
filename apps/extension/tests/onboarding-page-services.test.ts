import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { onboardingServices } from "@/onboarding/page-services";
import { POLL_MS } from "@/onboarding/service";
import type { OnboardingSnapshot } from "@/onboarding/service";
import { POC_READ_FILE } from "@/p2p/file-url-read";
import { pocOnboardingStore } from "@/storage/poc-onboarding-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { MASTER, MASTER_KEY, roleRepository } from "./role-fixture";

const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operation = { operationId: OP, basesDir: "/Users/me/Bases", baseName: "base-v1", clones: 2 };
const ROOT = "/Users/me/Downloads";
const REGISTRY_URL = `file://${ROOT}/RECnRun/poc/lab/registry.json`;
const STATUS_URL = `file://${ROOT}/RECnRun/poc/lab/ops/${OP}/status.json`;
const status = JSON.stringify({
  operationId: OP,
  step: "create-base",
  state: "running",
  message: "",
  clones: [],
  updatedAt: 1_800_000_000_000,
});

/** What the background answers: a file's text by URL (absent: unreadable), or a fixed reply. */
function background(files: Record<string, string> = {}, reply: unknown = { ok: true }) {
  const asked: { url: string; cache: string }[] = [];
  const sent: unknown[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (message: {
    type: string;
    url?: string;
    cache?: string;
  }) => {
    if (message.type !== POC_READ_FILE) {
      sent.push(message);
      return reply;
    }
    asked.push({ url: message.url ?? "", cache: message.cache ?? "" });
    const text = files[message.url ?? ""];
    return text === undefined
      ? { ok: false, error: { name: "TypeError", message: "Failed to fetch" } }
      : { ok: true, status: 0, text };
  }) as never);
  return { asked, sent };
}

function watch(onboarding = onboardingServices()) {
  const seen: OnboardingSnapshot[] = [];
  const stop = onboarding.watch((snapshot) => seen.push(snapshot));
  return { seen, stop, last: () => seen.at(-1) };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("onboardingServices master", () => {
  test("is the master only with the master record", async () => {
    expect(await onboardingServices().isMaster()).toBe(false);
    await roleRepository.write({ role: "master", profileId: MASTER, identity: MASTER_KEY });
    expect(await onboardingServices().isMaster()).toBe(true);
  });
});

describe("onboardingServices reading", () => {
  test("reads nothing until Chrome reported the Downloads root", async () => {
    const { asked } = background();
    const { last, stop } = watch();
    await vi.waitFor(() => expect(last()?.phase).toBe("idle"));
    expect(asked).toEqual([]);
    stop();
  });

  test("reads the registry in the default namespace, uncached, through the background", async () => {
    await pocPresenceStore().root.write(ROOT);
    const { asked } = background();
    const { last, stop } = watch();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked).toEqual([{ url: REGISTRY_URL, cache: "no-store" }]);
    expect(last()?.phase).toBe("idle");
    stop();
  });

  test("reads the registry of the namespace the profile stored", async () => {
    await pocPresenceStore().root.write(ROOT);
    await pocPresenceStore().setNamespace("e9-lab");
    const { asked } = background();
    const { stop } = watch();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]?.url).toBe(`file://${ROOT}/RECnRun/poc/e9-lab/registry.json`);
    stop();
  });

  test("falls back to the default namespace when the stored one is not a namespace", async () => {
    await pocPresenceStore().root.write(ROOT);
    await pocPresenceStore().setNamespace("../Evil");
    const { asked } = background();
    const { stop } = watch();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]?.url).toBe(REGISTRY_URL);
    stop();
  });

  test("also reads the status of the operation asked for, and shows it", async () => {
    await pocPresenceStore().root.write(ROOT);
    await pocOnboardingStore().operation.write(operation);
    const { asked } = background({ [STATUS_URL]: status });
    const { last, stop } = watch();
    await vi.waitFor(() => expect(last()?.phase).toBe("running"));
    expect(asked.map(({ url }) => url).sort()).toEqual([REGISTRY_URL, STATUS_URL].sort());
    stop();
  });

  test("polls on a timer until the page stops watching", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await pocPresenceStore().root.write(ROOT);
    const { asked } = background();
    const { stop } = watch();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(asked).toHaveLength(2);
  });
});

describe("onboardingServices requests", () => {
  test("asks the background with a fresh operation id and keeps the choice", async () => {
    const { sent } = background();
    const onboarding = onboardingServices();
    const { last, stop } = watch(onboarding);
    await vi.waitFor(() => expect(last()?.phase).toBe("idle"));
    await onboarding.request("/Users/me/Bases", 2);
    expect(sent).toEqual([
      {
        type: "POC_PREPARE_WORKERS",
        op: "request",
        choice: { ...operation, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      },
    ]);
    expect(await pocOnboardingStore().operation.read()).toMatchObject({ clones: 2 });
    expect(last()).toMatchObject({ phase: "requested", failure: "" });
    stop();
  });

  test("shows the background's refusal and keeps nothing", async () => {
    background({}, { ok: false, error: "Only the master prepares workers." });
    const onboarding = onboardingServices();
    const { last, stop } = watch(onboarding);
    await vi.waitFor(() => expect(last()?.phase).toBe("idle"));
    await onboarding.request("/Users/me/Bases", 2);
    expect(last()).toMatchObject({ phase: "idle", failure: "Only the master prepares workers." });
    expect(await pocOnboardingStore().operation.read()).toBeUndefined();
    stop();
  });

  test("shows a failure when the background sends a malformed reply", async () => {
    background({}, "garbage");
    const onboarding = onboardingServices();
    const { last, stop } = watch(onboarding);
    await vi.waitFor(() => expect(last()?.phase).toBe("idle"));
    await onboarding.request("/Users/me/Bases", 2);
    expect(last()?.failure).not.toBe("");
    expect(await pocOnboardingStore().operation.read()).toBeUndefined();
    stop();
  });
});
