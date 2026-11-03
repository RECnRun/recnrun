import type { DriverCommand } from "@recnrun/engine";
import type { Target } from "@recnrun/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createPageDriver, type ReplayPage } from "../src/replay.ts";
import { fakePage, timeoutError, type FakePageOptions } from "./replay-page.ts";

const READ = { timeoutMs: 500 };
const BOX: Target = { testId: "box" };
const T = '{"timeout":500}';

// A write's budget reads the clock between calls; a frozen one keeps every timeout at 500.
beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => void vi.useRealTimers());

/** A driver whose first write opens `page`; later `open()` calls open the pages that follow. */
function driverOver(options: FakePageOptions = {}, more: ReplayPage[] = []) {
  const { page, calls } = fakePage(options);
  const pages = [page, ...more];
  let opened = 0;
  const driver = createPageDriver(async () => {
    calls.push("open");
    const next = pages[opened];
    opened += 1;
    if (!next) throw new Error("No more tabs.");
    return next;
  });
  return { driver, page, calls };
}

async function opened(options: FakePageOptions = {}) {
  const made = driverOver(options);
  await made.driver.act({ kind: "navigate", url: "http://127.0.0.1:4600/" }, READ);
  made.calls.length = 0;
  return made;
}

describe("inspect", () => {
  test.each<[Target, string]>([
    ["#name", 'locator("#name")'],
    [{ testId: "status" }, 'getByTestId("status")'],
    [
      { role: "button", name: "Go", exact: true },
      'getByRole("button", {"name":"Go","exact":true})',
    ],
    [{ role: "status" }, 'getByRole("status", {})'],
    [{ text: "Done", exact: false }, 'getByText("Done", {"exact":false})'],
    [{ label: "Name" }, 'getByLabel("Name", {})'],
    [{ css: "form input" }, 'locator("form input")'],
    [{ xpath: "//input" }, 'locator("xpath=//input")'],
  ])("reads %j through %s", async (target, made) => {
    const { driver, calls } = await opened();
    expect(await driver.inspect(target, READ)).toEqual({
      count: 1,
      visible: true,
      enabled: true,
      editable: true,
      text: "Text",
      value: "Value",
    });
    expect(calls).toEqual([
      `${made}.isVisible`,
      `${made}.isEnabled ${T}`,
      `${made}.isEditable ${T}`,
      `${made}.textContent ${T}`,
      `${made}.inputValue ${T}`,
    ]);
  });

  test("an element that is not an input is not editable and has no value", async () => {
    const fail = { isEditable: new Error("Not an input"), inputValue: new Error("Not an input") };
    const { driver } = await opened({ fail });
    expect(await driver.inspect(BOX, READ)).toMatchObject({ editable: false, value: null });
  });

  test.each([0, 2])("%i matches read nothing more than the count", async (count) => {
    const { driver, calls } = await opened({ count });
    expect(await driver.inspect(BOX, READ)).toMatchObject({ count, visible: false });
    expect(calls).toEqual([]);
  });

  test("reads before the first write see no element and open no tab", async () => {
    const { driver, calls } = driverOver();
    expect(await driver.inspect(BOX, READ)).toMatchObject({ count: 0 });
    expect(await driver.readAttribute(BOX, "id", READ)).toBeNull();
    expect(await driver.tabs(READ)).toEqual({ tabs: [], current: null });
    expect(calls).toEqual([]);
  });

  test("reads an attribute of a single match only", async () => {
    expect(await (await opened()).driver.readAttribute(BOX, "data-sku", READ)).toBe("attr");
    expect(await (await opened({ count: 2 })).driver.readAttribute(BOX, "id", READ)).toBeNull();
  });

  test("rejects locators replay cannot resolve yet", async () => {
    const { driver } = await opened();
    const list = { locators: [{ testId: "status" }] } as Target;
    await expect(driver.inspect(list, READ)).rejects.toThrow(/not supported by replay yet/);
    await expect(driver.inspect({ functionRef: "a.b@1.0.0" }, READ)).rejects.toThrow(/replay/);
  });
});

describe("act", () => {
  test("navigates and reloads waiting for load, never networkidle", async () => {
    const { driver, calls } = driverOver();
    await driver.act({ kind: "navigate", url: "http://127.0.0.1:4600/a" }, READ);
    await driver.act({ kind: "reload" }, READ);
    expect(calls).toEqual([
      "open",
      `goto http://127.0.0.1:4600/a {"waitUntil":"load","timeout":500}`,
      `reload {"waitUntil":"load","timeout":500}`,
    ]);
  });

  test.each<["click" | "check" | "uncheck"]>([["click"], ["check"], ["uncheck"]])(
    "%s tries first, then dispatches once",
    async (kind) => {
      const { driver, calls } = await opened();
      expect(await driver.act({ kind, target: BOX }, READ)).toEqual({ status: "done" });
      expect(calls).toEqual([
        `getByTestId("box").${kind} {"trial":true,"timeout":500}`,
        `getByTestId("box").${kind} ${T}`,
      ]);
    },
  );

  test.each<[string, Error, string]>([
    ["a timeout", timeoutError(), "timeout"],
    ["several matches", new Error("strict mode violation: 2 elements"), "ambiguous"],
    ["anything else", new Error("Element is detached"), "adapter-error"],
  ])("a trial that fails on %s dispatches nothing", async (_name, error, code) => {
    const { driver, calls } = await opened({ fail: { "click:trial": error } });
    expect(await driver.act({ kind: "click", target: BOX }, READ)).toMatchObject({
      status: "not-dispatched",
      code,
    });
    expect(calls).toHaveLength(1);
  });

  test.each<[string, Error, string, string]>([
    ["a timeout", timeoutError(), "unknown", "timeout"],
    ["a lost page", new Error("Target closed"), "unknown", "adapter-error"],
    [
      "a refused navigation",
      new Error("net::ERR_CONNECTION_REFUSED"),
      "failed",
      "navigation-failed",
    ],
  ])("a dispatched click that fails on %s is reported once", async (_name, error, status, code) => {
    const { driver, calls } = await opened({ fail: { click: error } });
    expect(await driver.act({ kind: "click", target: BOX }, READ)).toMatchObject({ status, code });
    expect(calls.filter((call) => call.includes(".click"))).toHaveLength(2);
  });

  test("a failure keeps the first line of the message, without Playwright's call log", async () => {
    const log =
      "locator.click: Timeout 900ms exceeded.\nCall log:\n\u001b[2m  - waiting\u001b[22m\n";
    const { driver } = await opened({ fail: { click: timeoutError(log) } });
    expect(await driver.act({ kind: "click", target: BOX }, READ)).toEqual({
      status: "unknown",
      code: "timeout",
      message: "locator.click: Timeout 900ms exceeded.",
    });
  });

  test.each<[string, DriverCommand, string[]]>([
    ["fill", { kind: "fill", target: BOX, value: "Ada" }, [`getByTestId("box").fill "Ada" ${T}`]],
    [
      "type",
      { kind: "type", target: BOX, value: "Ada" },
      [`getByTestId("box").pressSequentially "Ada" ${T}`],
    ],
    [
      "select",
      { kind: "select", target: BOX, value: "Green" },
      [`getByTestId("box").evaluate "Green" ${T}`, `getByTestId("box").selectOption "Green" ${T}`],
    ],
    ["keyPress on the page", { kind: "keyPress", key: "Escape" }, ["keyboard.press Escape"]],
    [
      "keyPress on a target",
      { kind: "keyPress", key: "Enter", target: BOX },
      [`getByTestId("box").press "Enter" ${T}`],
    ],
    [
      "scroll the page",
      { kind: "scroll", deltaX: 0, deltaY: 400 },
      [`locator(":root").evaluate [0,400] ${T}`],
    ],
    [
      "scroll to a target",
      { kind: "scroll", target: BOX, deltaX: 0, deltaY: 0 },
      [`getByTestId("box").scrollIntoViewIfNeeded ${T}`],
    ],
    [
      "scroll inside a target",
      { kind: "scroll", target: BOX, deltaX: 0, deltaY: 50 },
      [`getByTestId("box").evaluate [0,50] ${T}`],
    ],
  ])("%s dispatches once", async (_name, command, expected) => {
    const { driver, calls } = await opened();
    expect(await driver.act(command, READ)).toEqual({ status: "done" });
    expect(calls).toEqual(expected);
  });

  test("a select without the option is refused before anything is chosen", async () => {
    const { driver, calls } = await opened({ evaluates: false });
    const result = await driver.act({ kind: "select", target: BOX, value: "Blue" }, READ);
    expect(result).toMatchObject({ status: "not-dispatched", code: "not-actionable" });
    expect(calls.some((call) => call.includes("selectOption"))).toBe(false);
  });

  test("a locator it cannot resolve dispatches nothing", async () => {
    const { driver } = await opened();
    const target = { functionRef: "a.b@1.0.0" };
    const result = await driver.act({ kind: "click", target }, READ);
    expect(result).toMatchObject({ status: "not-dispatched", code: "adapter-error" });
  });

  test("a deadline already passed still gives Playwright a positive timeout", async () => {
    const { driver, calls } = await opened();
    await driver.act({ kind: "fill", target: BOX, value: "x" }, { timeoutMs: -5 });
    expect(calls).toEqual(['getByTestId("box").fill "x" {"timeout":1}']);
  });

  test("opens the first tab again on the next write after opening failed", async () => {
    const { page } = fakePage();
    const opens = [() => Promise.reject(new Error("No tab.")), () => Promise.resolve(page)];
    const driver = createPageDriver(() => (opens.shift() ?? (() => Promise.resolve(page)))());
    const go: DriverCommand = { kind: "navigate", url: "http://127.0.0.1:4600/" };
    expect(await driver.act(go, READ)).toMatchObject({
      status: "not-dispatched",
      message: "No tab.",
    });
    expect(await driver.act(go, READ)).toEqual({ status: "done" });
    expect(opens).toEqual([]);
  });
});

describe("tabs", () => {
  test("lists opened tabs and popups in order, and selects and closes them", async () => {
    const second = fakePage({ title: "Second" });
    const popup = fakePage({ url: "http://127.0.0.1:4600/popup", title: "Popup" });
    const { driver, page } = driverOver({ title: "First", fail: {} }, [second.page]);
    await driver.act({ kind: "navigate", url: "http://127.0.0.1:4600/a" }, READ);
    page.popup(popup.page);
    await driver.act({ kind: "openTab", url: "http://127.0.0.1:4600/b" }, READ);
    expect(await driver.tabs(READ)).toEqual({
      tabs: [
        { url: "http://127.0.0.1:4600/a", title: "First" },
        { url: "http://127.0.0.1:4600/popup", title: "Popup" },
        { url: "http://127.0.0.1:4600/b", title: "Second" },
      ],
      current: 2,
    });
    expect(await driver.act({ kind: "selectTab", index: 1 }, READ)).toEqual({ status: "done" });
    expect(popup.calls).toEqual(["bringToFront http://127.0.0.1:4600/popup"]);
    expect(await driver.act({ kind: "closeTab" }, READ)).toEqual({ status: "done" });
    expect(await driver.tabs(READ)).toMatchObject({
      current: 1,
      tabs: [{ title: "First" }, { title: "Second" }],
    });
    const missing = await driver.act({ kind: "selectTab", index: 5 }, READ);
    expect(missing).toMatchObject({ status: "not-dispatched", code: "adapter-error" });
  });

  test("a blank new tab, a title that cannot be read, and closing the last tab", async () => {
    const second = fakePage({ fail: { title: new Error("Navigating") } });
    const { driver } = driverOver({}, [second.page]);
    await driver.act({ kind: "openTab" }, READ);
    await driver.act({ kind: "openTab" }, READ);
    expect(await driver.tabs(READ)).toEqual({
      tabs: [
        { url: "about:blank", title: "" },
        { url: "about:blank", title: "" },
      ],
      current: 1,
    });
    await driver.act({ kind: "closeTab" }, READ);
    await driver.act({ kind: "closeTab" }, READ);
    expect(await driver.tabs(READ)).toEqual({ tabs: [], current: null });
    expect(await driver.act({ kind: "closeTab" }, READ)).toEqual({ status: "done" });
  });
});
