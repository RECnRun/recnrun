import { describe, expect, test } from "vite-plus/test";
import type { TargetInfo } from "@/background/probes/types";
import { SelectionEngine } from "@/background/selection/engine";
import { exposeSelection, SELECTION_GLOBAL } from "@/background/selection/expose";
import type { SelectionApis, SessionRule } from "@/background/selection/types";
import { fakeDebugger, NOT_ALLOWED } from "./fake-debugger";

// E6 (POC PLAN.md P1.5): session rules point the selection URLs at a slot; the background can stop itself.
const ALREADY = "Another debugger is already attached to the target with id: ";
const EXTENSION = "chrome-extension://isolator/";
const APP = "http://app.localhost:4600";
const STAGING = "http://app.localhost:4603";
const SELF: TargetInfo = {
  type: "worker",
  id: "self",
  url: `${EXTENSION}background.js`,
  attached: false,
};
const APP_WORKER: TargetInfo = {
  type: "worker",
  id: "sw",
  url: `${APP}/sw-main.js`,
  attached: false,
};

interface SetupOptions {
  targets?: TargetInfo[];
  attachError?: string;
  rules?: SessionRule[];
  /** A previous instance of the background is still attached to its own target. */
  stale?: boolean;
}

function setup(options: SetupOptions = {}) {
  const fake = fakeDebugger({ targets: options.targets ?? [APP_WORKER, SELF] });
  const rules = new Map<number, SessionRule>((options.rules ?? []).map((rule) => [rule.id, rule]));
  const updates: object[] = [];
  const stored: Record<string, unknown> = {};
  const scheduled: (() => Promise<void>)[] = [];
  let stale = options.stale ?? false;
  const apis: SelectionApis = {
    debugger: {
      ...fake.api,
      attach: async (target, version) => {
        if (options.attachError) throw new Error(options.attachError);
        if (stale) throw new Error(`${ALREADY}${target.targetId}.`);
        await fake.api.attach(target, version);
      },
      detach: async (target) => {
        stale = false;
        await fake.api.detach(target);
      },
    },
    dnr: {
      updateSessionRules: async (update) => {
        updates.push(update);
        for (const id of update.removeRuleIds ?? []) rules.delete(id);
        for (const rule of update.addRules ?? []) rules.set(rule.id, rule);
      },
      getSessionRules: async () => [...rules.values()],
    },
    storage: {
      get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (items) => void Object.assign(stored, items),
    },
    extensionOrigin: EXTENSION,
  };
  let clock = 0;
  const engine = new SelectionEngine(() => apis, {
    now: () => (clock += 2),
    timeOrigin: 1_000,
    schedule: (task) => void scheduled.push(task),
  });
  return { ...fake, apis, engine, rules, updates, stored, scheduled };
}

const redirect = (slot: number) => ({
  type: "redirect",
  redirect: { extensionPath: `/ns/slot-${slot}.js` },
});

describe("SelectionEngine.select", () => {
  test("points the extension's ns/current.js and each origin's /recnrun/current.js at the slot", async () => {
    const { engine, rules } = setup();
    const selected = await engine.select({ slot: 3, origins: [APP, STAGING] });
    expect(selected).toEqual({
      slot: 3,
      file: "ns/slot-3.js",
      ruleIds: [6100, 6101, 6102],
      removed: [],
      updateMs: 2,
    });
    expect([...rules.values()]).toEqual([
      {
        id: 6100,
        priority: 1,
        action: redirect(3),
        condition: { urlFilter: `|${EXTENSION}ns/current.js` },
      },
      {
        id: 6101,
        priority: 1,
        action: redirect(3),
        condition: { urlFilter: `|${APP}/recnrun/current.js` },
      },
      {
        id: 6102,
        priority: 1,
        action: redirect(3),
        condition: { urlFilter: `|${STAGING}/recnrun/current.js` },
      },
    ]);
  });

  test("a switch replaces its own rules in one update and leaves other rules alone", async () => {
    const other = {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: { regexFilter: "^x" },
    };
    const { engine, rules, updates } = setup({ rules: [other] });
    await engine.select({ slot: 1, origins: [APP] });
    const switched = await engine.select({ slot: 2, origins: [APP] });
    expect(switched.removed).toEqual([6100, 6101]);
    expect(updates.at(-1)).toMatchObject({ removeRuleIds: [6100, 6101] });
    expect([...rules.keys()].sort((a, b) => a - b)).toEqual([1, 6100, 6101]);
    expect(rules.get(6101)?.action).toEqual(redirect(2));
  });

  test("refuses a slot without a file, an origin off the loopback, and malformed requests", async () => {
    const { engine, updates } = setup();
    await expect(engine.select({ slot: 10, origins: [APP] })).rejects.toThrow(/invalid request/);
    await expect(engine.select({ slot: 1, origins: ["https://example.com"] })).rejects.toThrow(
      /not on the loopback/,
    );
    await expect(engine.select({ slot: 1, origins: [`${APP}/path`] })).rejects.toThrow(
      /expected an origin/,
    );
    await expect(engine.select("slot-1")).rejects.toThrow(/invalid request/);
    expect(updates).toEqual([]);
  });

  test("clear removes only its own rules, and rules lists them", async () => {
    const other = {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: { regexFilter: "^x" },
    };
    const { engine, rules } = setup({ rules: [other] });
    await engine.select({ slot: 5, origins: [APP] });
    expect((await engine.rules()).map((rule) => rule.id)).toEqual([6100, 6101]);
    expect(await engine.clear()).toEqual({ removed: [6100, 6101] });
    expect([...rules.keys()]).toEqual([1]);
    expect(await engine.clear()).toEqual({ removed: [] });
  });
});

describe("exposeSelection", () => {
  test("installs the engine on globalThis and notes each new tab as a wake", async () => {
    const listeners: (() => void)[] = [];
    const { apis } = setup();
    exposeSelection(() => apis, {
      addListener: (listener) => void listeners.push(listener),
    });
    const engine = Reflect.get(globalThis, SELECTION_GLOBAL) as SelectionEngine;
    expect(engine).toBeInstanceOf(SelectionEngine);
    listeners.forEach((listener) => listener());
    expect((await engine.status()).wakes.map((wake) => wake.event)).toEqual(["tabs.onCreated"]);
  });
});

describe("SelectionEngine.suspend and status", () => {
  test("records the request, then closes its own worker target through its own session", async () => {
    const { engine, sent, stored, scheduled } = setup();
    expect(await engine.suspend()).toEqual({ targetId: "self", timeOrigin: 1_000 });
    expect(stored.e6Suspend).toEqual({ targetId: "self", timeOrigin: 1_000, requestedAt: 2 });
    expect(sent).toEqual([]);
    await scheduled[0]?.();
    expect(sent.map(({ target, method, params }) => [target, method, params])).toEqual([
      [{ targetId: "self" }, "Target.closeTarget", { targetId: "self" }],
    ]);
    expect(stored.e6Suspend).toMatchObject({ attach: "ok" });
  });

  test("stores Chrome's refusal when it cannot attach to itself", async () => {
    const { engine, sent, stored, scheduled } = setup({ attachError: NOT_ALLOWED });
    await engine.suspend();
    await scheduled[0]?.();
    expect(sent).toEqual([]);
    expect(stored.e6Suspend).toMatchObject({ attach: NOT_ALLOWED });
  });

  test("detaches the session a previous instance left on its target before attaching", async () => {
    const { engine, sent, stored, scheduled } = setup({ stale: true });
    await engine.suspend();
    await scheduled[0]?.();
    expect(stored.e6Suspend).toMatchObject({ attach: "ok" });
    expect(sent.map(({ method }) => method)).toEqual(["Target.closeTarget"]);
  });

  test("fails when Chrome lists no worker of the extension", async () => {
    const { engine, scheduled } = setup({ targets: [APP_WORKER] });
    await expect(engine.suspend()).rejects.toThrow(`no worker target at ${EXTENSION}`);
    expect(scheduled).toEqual([]);
  });

  test("status reports this worker's time origin, what woke it, the stored suspension, and the rules", async () => {
    const { engine } = setup();
    await engine.select({ slot: 0, origins: [APP] });
    await engine.suspend();
    engine.woke("tabs.onCreated");
    expect(await engine.status()).toEqual({
      timeOrigin: 1_000,
      wakes: [{ event: "tabs.onCreated", at: 8 }],
      suspend: { targetId: "self", timeOrigin: 1_000, requestedAt: 6 },
      ruleIds: [6100, 6101],
    });
  });
});
