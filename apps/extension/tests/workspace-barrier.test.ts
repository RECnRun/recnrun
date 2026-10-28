import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  AGENT_SCRIPT,
  BARRIER_CSP,
  chromeBarrierApi,
  declaredLocations,
  installBarrier,
  removeBarrier,
} from "@/background/workspace/barrier";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";

const TAB = 7;
const ORIGIN = "http://app.localhost:5192";
const TARGET = { origin: ORIGIN, declaredHosts: [] };
const SSO_TARGET = { origin: ORIGIN, declaredHosts: ["SSO.localhost"] };
const OPERATION = { id: "op-1", generation: 3 };

let api: FakeBarrierApi;

beforeEach(() => {
  fakeBrowser.reset();
  api = fakeBarrierApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installBarrier", () => {
  test("appends the script-blocking CSP to the tab's documents and frames", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    expect(BARRIER_CSP).toBe(
      "script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'",
    );
    const csp = [...api.rules.values()].find(({ action }) => action.type === "modifyHeaders");
    expect(csp?.action.responseHeaders).toEqual([
      { header: "Content-Security-Policy", operation: "append", value: BARRIER_CSP },
    ]);
    expect(csp?.condition).toEqual({ tabIds: [TAB], resourceTypes: ["main_frame", "sub_frame"] });
  });

  test("blocks every request of the tab but its documents on the target origin", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    const rules = [...api.rules.values()];
    expect(
      rules.every(({ condition }) => condition.tabIds.length === 1 && condition.tabIds[0] === TAB),
    ).toBe(true);
    const blocks = rules.filter(({ action }) => action.type === "block");
    expect(blocks.map(({ condition }) => condition)).toEqual(
      expect.arrayContaining([
        { tabIds: [TAB], excludedResourceTypes: ["main_frame"] },
        { tabIds: [TAB], resourceTypes: ["main_frame"] },
      ]),
    );
    const allow = rules.find(({ action }) => action.type === "allow");
    expect(allow?.condition).toEqual({
      tabIds: [TAB],
      resourceTypes: ["main_frame"],
      urlFilter: `|${ORIGIN}/`,
    });
    // The allow beats the main-frame block, and stays under the CSP rule so the header still applies.
    const csp = rules.find(({ action }) => action.type === "modifyHeaders");
    const priorities = blocks.map(({ priority }) => priority);
    expect(Math.max(...priorities)).toBeLessThan(allow?.priority ?? 0);
    expect(allow?.priority ?? 0).toBeLessThan(csp?.priority ?? 0);
  });

  test("registers the origin agent for the target origin only, at document_start, for this session", async () => {
    const barrier = await installBarrier(TAB, TARGET, OPERATION, api);
    expect([...api.scripts.values()]).toEqual([
      {
        id: barrier.scriptId,
        js: [AGENT_SCRIPT],
        matches: [`${ORIGIN}/*`],
        runAt: "document_start",
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    expect(AGENT_SCRIPT).toBe("content-scripts/origin-agent.js");
    expect(barrier.scriptId).toContain(OPERATION.id);
  });

  test("derives rule ids from the generation, so two operations never share one", async () => {
    const first = await installBarrier(TAB, SSO_TARGET, OPERATION, api);
    const second = await installBarrier(8, TARGET, { id: "op-2", generation: 4 }, api);
    expect(first.ruleIds).toHaveLength(5);
    expect(new Set([...first.ruleIds, ...second.ruleIds]).size).toBe(10);
    // Without declared hosts the last id stays free: there is no hand-over rule.
    expect([...api.rules.keys()].toSorted((a, b) => a - b)).toEqual(
      [...first.ruleIds, ...second.ruleIds.slice(0, 4)].toSorted((a, b) => a - b),
    );
  });

  test("refuses ids already in use, and leaves the other barrier alone", async () => {
    const existing = await installBarrier(TAB, TARGET, OPERATION, api);
    await expect(
      installBarrier(TAB, TARGET, { id: "op-9", generation: 3 }, api),
    ).rejects.toMatchObject({
      name: "BarrierCollision",
    });
    await expect(
      installBarrier(TAB, TARGET, { id: "op-1", generation: 5 }, api),
    ).rejects.toMatchObject({
      name: "BarrierCollision",
    });
    expect([...api.rules.keys()]).toEqual(existing.ruleIds.slice(0, 4));
    expect([...api.scripts.keys()]).toEqual([existing.scriptId]);
  });

  test("removes its rules again when the agent cannot be registered", async () => {
    api.registerError = new Error("Chrome refused.");
    await expect(installBarrier(TAB, TARGET, OPERATION, api)).rejects.toMatchObject({
      name: "BarrierNotInstalled",
    });
    expect(api.rules.size).toBe(0);
  });

  test("strips a redirect to a declared host, above the allow rule, so the document commits on the origin", async () => {
    await installBarrier(TAB, SSO_TARGET, OPERATION, api);
    const rules = [...api.rules.values()];
    const handOver = rules.find(({ condition }) => condition.responseHeaders !== undefined);
    expect(handOver?.action).toEqual({
      type: "modifyHeaders",
      responseHeaders: [{ header: "location", operation: "remove" }],
    });
    expect(handOver?.condition).toMatchObject({ tabIds: [TAB], resourceTypes: ["main_frame"] });
    expect(handOver?.condition.responseHeaders).toEqual([
      { header: "location", values: declaredLocations(["sso.localhost"]) },
    ]);
    const allow = rules.find(({ action }) => action.type === "allow");
    expect(handOver?.priority ?? 0).toBeGreaterThan(allow?.priority ?? 0);
  });

  test("matches a declared host's Location values by scheme, path, and port only", () => {
    const values = declaredLocations(["SSO.localhost"]);
    expect(values).toEqual([
      "http://sso.localhost",
      "http://sso.localhost/*",
      "http://sso.localhost:*",
      "https://sso.localhost",
      "https://sso.localhost/*",
      "https://sso.localhost:*",
      "//sso.localhost",
      "//sso.localhost/*",
      "//sso.localhost:*",
    ]);
    // `?` matches one optional character in Chrome, so a pattern must not carry it.
    expect(values.some((value) => value.includes("?"))).toBe(false);
  });

  test("adds no hand-over rule when the identity declares no host", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    const rules = [...api.rules.values()];
    expect(rules).toHaveLength(4);
    expect(rules.some(({ condition }) => condition.responseHeaders !== undefined)).toBe(false);
  });

  test("refuses a target that is not an http(s) origin", async () => {
    for (const target of [
      `${ORIGIN}/app/`,
      "chrome://settings",
      "not a url",
      "https://app.example:443",
    ]) {
      await expect(
        installBarrier(TAB, { origin: target, declaredHosts: [] }, OPERATION, api),
        target,
      ).rejects.toMatchObject({
        name: "TargetNotAllowed",
      });
    }
    expect(api.rules.size).toBe(0);
  });
});

describe("removeBarrier", () => {
  test("removes only its own rules and script, and checks that they are gone", async () => {
    const other = await installBarrier(
      8,
      { origin: "http://other.localhost:5192", declaredHosts: [] },
      { id: "op-0", generation: 2 },
      api,
    );
    const barrier = await installBarrier(TAB, TARGET, OPERATION, api);
    await removeBarrier(barrier, api);
    expect([...api.rules.keys()]).toEqual(other.ruleIds.slice(0, 4));
    expect([...api.scripts.keys()]).toEqual([other.scriptId]);
    // Removing twice is harmless: the second finds nothing left.
    await expect(removeBarrier(barrier, api)).resolves.toBeUndefined();
  });

  test("fails when Chrome still lists a rule or the script afterwards", async () => {
    const barrier = await installBarrier(TAB, TARGET, OPERATION, api);
    api.ignoreRemovals = true;
    await expect(removeBarrier(barrier, api)).rejects.toMatchObject({ name: "BarrierNotRemoved" });
  });
});

describe("chromeBarrierApi", () => {
  test("goes through declarativeNetRequest session rules and scripting registrations", async () => {
    const dnr = fakeBrowser.declarativeNetRequest;
    const scripting = fakeBrowser.scripting;
    const update = vi.spyOn(dnr, "updateSessionRules").mockResolvedValue(undefined as never);
    vi.spyOn(dnr, "getSessionRules").mockResolvedValue([{ id: 99 }] as never);
    const register = vi
      .spyOn(scripting, "registerContentScripts")
      .mockResolvedValue(undefined as never);
    const unregister = vi
      .spyOn(scripting, "unregisterContentScripts")
      .mockResolvedValue(undefined as never);
    vi.spyOn(scripting, "getRegisteredContentScripts").mockResolvedValue([{ id: "a" }] as never);

    const barrier = await installBarrier(TAB, TARGET, OPERATION, chromeBarrierApi);
    expect(update).toHaveBeenCalledWith({ addRules: expect.any(Array) });
    expect(register).toHaveBeenCalledWith([expect.objectContaining({ id: barrier.scriptId })]);
    await expect(chromeBarrierApi.sessionRuleIds()).resolves.toEqual([99]);
    await expect(chromeBarrierApi.registeredScriptIds()).resolves.toEqual(["a"]);
    await chromeBarrierApi.removeSessionRules([99]);
    expect(update).toHaveBeenLastCalledWith({ removeRuleIds: [99] });
    await chromeBarrierApi.unregisterScript("a");
    expect(unregister).toHaveBeenCalledWith({ ids: ["a"] });
  });
});
