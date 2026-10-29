import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  AGENT_SCRIPT,
  BARRIER_CSP,
  BARRIER_STYLE,
  chromeBarrierApi,
  installAnonymousBarrier,
  installBarrier,
  removeBarrier,
} from "@/background/workspace/barrier";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";

const TAB = 7;
const ORIGIN = "http://app.localhost:5192";
const TARGET = ORIGIN;
const OPERATION = { id: "op-1", generation: 3 };

let api: FakeBarrierApi;

const literal = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Chrome's header value pattern: `*` any run, `?` one optional character, `\\` escapes the next. */
function matches(pattern: string, value: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "\\") source += literal(pattern[++index] ?? "");
    else if (char === "*") source += ".*";
    else if (char === "?") source += ".?";
    else source += literal(char);
  }
  return new RegExp(`^${source}$`, "s").test(value.toLowerCase());
}

/** Whether Chrome would apply the rule's header condition to `location` (request_params.cc). */
function strips(header: { values?: string[]; excludedValues?: string[] }, location: string) {
  const any = (patterns: string[] = []) => patterns.some((each) => matches(each, location));
  return any(header.values) && !any(header.excludedValues);
}

beforeEach(() => {
  fakeBrowser.reset();
  api = fakeBarrierApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installBarrier", () => {
  test("serves the tab's documents and frames script-free, as plain text Chrome never downloads", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    expect(BARRIER_CSP).toBe(
      "script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'",
    );
    const csp = [...api.rules.values()].find(
      ({ condition }) => condition.resourceTypes?.length === 2,
    );
    expect(csp?.action.responseHeaders).toEqual([
      { header: "Content-Security-Policy", operation: "append", value: BARRIER_CSP },
      { header: "content-type", operation: "set", value: "text/plain" },
      { header: "x-content-type-options", operation: "set", value: "nosniff" },
      { header: "content-disposition", operation: "remove" },
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
    const csp = rules.find(({ condition }) => condition.resourceTypes?.length === 2);
    const priorities = blocks.map(({ priority }) => priority);
    expect(Math.max(...priorities)).toBeLessThan(allow?.priority ?? 0);
    expect(allow?.priority ?? 0).toBeLessThan(csp?.priority ?? 0);
  });

  test("registers the origin agent and the style that hides its document for the target origin only, at document_start, for this session", async () => {
    const barrier = await installBarrier(TAB, TARGET, OPERATION, api);
    expect([...api.scripts.values()]).toEqual([
      {
        id: barrier.scriptId,
        js: [AGENT_SCRIPT],
        css: [BARRIER_STYLE],
        matches: [`${ORIGIN}/*`],
        runAt: "document_start",
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    expect(AGENT_SCRIPT).toBe("content-scripts/origin-agent.js");
    expect(BARRIER_STYLE).toBe("barrier.css");
    expect(barrier.scriptId).toContain(OPERATION.id);
  });

  test("derives rule ids from the generation, so two operations never share one", async () => {
    const first = await installBarrier(TAB, TARGET, OPERATION, api);
    const second = await installBarrier(8, TARGET, { id: "op-2", generation: 4 }, api);
    // The sixth id is the anonymous rule's, listed even when it is not installed.
    expect(first.ruleIds).toHaveLength(6);
    expect(new Set([...first.ruleIds, ...second.ruleIds]).size).toBe(12);
    expect([...api.rules.keys()].toSorted((a, b) => a - b)).toEqual([
      ...first.ruleIds.slice(0, 5),
      ...second.ruleIds.slice(0, 5),
    ]);
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
    expect([...api.rules.keys()]).toEqual(existing.ruleIds.slice(0, 5));
    expect([...api.scripts.keys()]).toEqual([existing.scriptId]);
  });

  test("removes its rules again when the agent cannot be registered", async () => {
    api.registerError = new Error("Chrome refused.");
    await expect(installBarrier(TAB, TARGET, OPERATION, api)).rejects.toMatchObject({
      name: "BarrierNotInstalled",
    });
    expect(api.rules.size).toBe(0);
  });
});

describe("installBarrier's redirect hand-over", () => {
  test("strips a redirect off the target origin, above the allow rule, so the document commits on the origin", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    const rules = [...api.rules.values()];
    const handOver = rules.find(({ condition }) => condition.responseHeaders !== undefined);
    expect(handOver?.action).toEqual({
      type: "modifyHeaders",
      responseHeaders: [{ header: "location", operation: "remove" }],
    });
    expect(handOver?.condition).toMatchObject({ tabIds: [TAB], resourceTypes: ["main_frame"] });
    const allow = rules.find(({ action }) => action.type === "allow");
    expect(handOver?.priority ?? 0).toBeGreaterThan(allow?.priority ?? 0);
  });

  test("removes every Location that leaves the target origin, and keeps those that stay on it", async () => {
    await installBarrier(TAB, TARGET, OPERATION, api);
    const handOver = [...api.rules.values()].find(({ condition }) => condition.responseHeaders);
    const [header] = handOver?.condition.responseHeaders ?? [];
    const removes = (location: string) => header !== undefined && strips(header, location);
    const stays = [
      "/app/?run=1",
      "callback?run=1",
      "?page=2",
      "#top",
      `${ORIGIN}`,
      `${ORIGIN}/sso-app/`,
      `${ORIGIN}?x=1`,
      `${ORIGIN}#top`,
      "HTTP://APP.localhost:5192/app/",
    ];
    for (const location of stays) expect(removes(location), location).toBe(false);
    const leaves = [
      "http://sso.localhost:5192/sso/authorize?prompt=none",
      "HTTPS://SSO.LOCALHOST/",
      "https://app.localhost:5192/",
      "http://app.localhost:5193/",
      "http://app.localhost:5192.evil.example/",
      "http://app.localhost:5192@evil.example/",
      "//sso.localhost/",
      "/\\evil.example/",
      "\\\\evil.example/",
      "\\/evil.example/",
      "/\t/evil.example/",
      "\u0001//evil.example/",
      "https:evil.example",
      "data:text/html,x",
    ];
    for (const location of leaves) expect(removes(location), location).toBe(true);
  });

  test("refuses a target that is not an http(s) origin", async () => {
    for (const target of [
      `${ORIGIN}/app/`,
      "chrome://settings",
      "not a url",
      "https://app.example:443",
    ]) {
      await expect(installBarrier(TAB, target, OPERATION, api), target).rejects.toMatchObject({
        name: "TargetNotAllowed",
      });
    }
    expect(api.rules.size).toBe(0);
  });
});

describe("installAnonymousBarrier", () => {
  test("an anonymous barrier, for a helper tab, sends no cookie and keeps every Set-Cookie out", async () => {
    const barrier = await installAnonymousBarrier(TAB, TARGET, OPERATION, api);
    expect([...api.rules.keys()]).toEqual(barrier.ruleIds);
    const anonymous = api.rules.get(barrier.ruleIds[5] ?? 0);
    expect(anonymous).toEqual({
      id: barrier.ruleIds[5],
      priority: 3,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "remove" }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }],
      },
      condition: { tabIds: [TAB], resourceTypes: ["main_frame"] },
    });
    // Above the allow rule, which would otherwise suppress it.
    const allow = [...api.rules.values()].find(({ action }) => action.type === "allow");
    expect(allow?.priority ?? 0).toBeLessThan(anonymous?.priority ?? 0);
    await removeBarrier(barrier, api);
    expect(api.rules.size).toBe(0);
  });
});

describe("removeBarrier", () => {
  test("removes only its own rules and script, and checks that they are gone", async () => {
    const other = await installBarrier(
      8,
      "http://other.localhost:5192",
      { id: "op-0", generation: 2 },
      api,
    );
    const barrier = await installBarrier(TAB, TARGET, OPERATION, api);
    await removeBarrier(barrier, api);
    expect([...api.rules.keys()]).toEqual(other.ruleIds.slice(0, 5));
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
