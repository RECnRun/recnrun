import type { CDPSession, Page } from "@playwright/test";
import {
  resolveFunctionLocator,
  type FunctionLocatorResolution,
} from "../../packages/adapter/src/index.ts";
import type { FunctionLocatorRequest } from "../../packages/protocol/src/index.ts";
import { expect, test as appTest } from "./fixtures/fixture-app.ts";

declare global {
  interface Window {
    __recnrunLeak?: boolean;
  }
}

interface Located {
  page: Page;
  /** A CDP session of the test's own, standing in for whoever acts on the references later. */
  inspector: CDPSession;
  targetId: string;
  mainFrameId: string;
  locate: (request: Partial<FunctionLocatorRequest>) => Promise<FunctionLocatorResolution>;
  /** The `data-testid` of the node a reference names, read through its backend node id. */
  testIdOf: (backendNodeId: number) => Promise<unknown>;
}

const test = appTest.extend<{ open: (route: string) => Promise<Located> }>({
  open: async ({ app, chrome }, use) => {
    const held: FunctionLocatorResolution[] = [];
    await use(async (route) => {
      const page = await app.open(route);
      const inspector = await page.context().newCDPSession(page);
      const { targetInfo } = await inspector.send("Target.getTargetInfo");
      const { frameTree } = await inspector.send("Page.getFrameTree");
      const locate = async (request: Partial<FunctionLocatorRequest>) => {
        const full = { source: "() => null", cardinality: "one" as const, timeoutMs: 2_000 };
        const target = { endpoint: chrome.wsEndpoint, targetId: targetInfo.targetId };
        const result = await resolveFunctionLocator(target, { ...full, ...request });
        held.push(result);
        return result;
      };
      const testIdOf = async (backendNodeId: number) => {
        const { object } = await inspector.send("DOM.resolveNode", { backendNodeId });
        const { result } = await inspector.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function () { return this.dataset.testid; }",
          returnByValue: true,
        });
        return result.value;
      };
      const mainFrameId = frameTree.frame.id;
      return { page, inspector, targetId: targetInfo.targetId, mainFrameId, locate, testIdOf };
    });
    for (const each of held) await each.release();
  },
});

const INPUTS = "({ root }) => root.querySelectorAll('input')";

test("zero, one, and many form controls under each cardinality", async ({ open }) => {
  const { locate, testIdOf, targetId, mainFrameId } = await open("form");
  const one = await locate({ source: "({ root }) => root.querySelector('[data-testid=name]')" });
  expect(one).toMatchObject({ status: "matched", cardinality: "one", count: 1 });
  expect(one.elements[0]).toMatchObject({ targetId, frameId: mainFrameId });
  expect(await testIdOf(one.elements[0]?.backendNodeId ?? 0)).toBe("name");

  const many = await locate({ source: INPUTS, cardinality: "many" });
  const ids = await Promise.all(many.elements.map((each) => testIdOf(each.backendNodeId)));
  expect(ids).toEqual(["name", "terms", "contact-email", "contact-phone", "attachment"]);
  expect(many).toMatchObject({ status: "matched", count: 5 });

  expect(await locate({ source: INPUTS })).toMatchObject({
    status: "ambiguous",
    count: 5,
    elements: [],
  });
  const third = await locate({ source: INPUTS, cardinality: "nth", index: 2 });
  expect(await testIdOf(third.elements[0]?.backendNodeId ?? 0)).toBe("contact-email");
  expect(await locate({ source: INPUTS, cardinality: "nth", index: 9 })).toMatchObject({
    status: "not-found",
    count: 5,
  });

  const none = "({ root }) => root.querySelectorAll('textarea')";
  expect(await locate({ source: none })).toMatchObject({ status: "not-found", count: 0 });
  expect(await locate({ source: none, cardinality: "optional" })).toMatchObject({
    status: "matched",
    count: 0,
    elements: [],
  });
  expect(await locate({ source: "() => null", cardinality: "optional" })).toMatchObject({
    status: "matched",
    count: 0,
  });
});

test("a row of the virtual list by key, with arguments, and an unrendered key", async ({
  open,
}) => {
  const { page, locate, testIdOf } = await open("virtual-list");
  const byKey = '({ root }, { key }) => root.querySelector(`[data-key="${key}"] button`)';
  const row = await locate({ source: byKey, args: { key: "row-key-3" } });
  expect(row).toMatchObject({ status: "matched", count: 1 });
  expect(await testIdOf(row.elements[0]?.backendNodeId ?? 0)).toBe("row-button-3");

  expect(await locate({ source: byKey, args: { key: "row-key-9999" } })).toMatchObject({
    status: "not-found",
  });
  const rows = await locate({
    source: "async ({ root }) => [...root.querySelectorAll('[role=listitem]')]",
    cardinality: "many",
  });
  const rendered = await page.getByTestId("list").getAttribute("data-rendered");
  expect(rows).toMatchObject({ status: "matched", count: Number(rendered) });
});

test("a throwing function is an error and a string is unsupported", async ({ open }) => {
  const { locate } = await open("form");
  expect(await locate({ source: "() => { throw new Error('boom'); }" })).toMatchObject({
    status: "error",
    count: 0,
    error: { message: "Error: boom" },
  });
  expect(await locate({ source: "() => 'input'" })).toMatchObject({
    status: "unsupported",
    error: { message: "The locator function returned a string, not elements." },
  });
  expect(await locate({ source: "() => [document.body, 'x']" })).toMatchObject({
    status: "unsupported",
    error: { message: "TypeError: Item 1 is not an element connected to the frame's document." },
  });
});

test("the function runs in an isolated world", async ({ open }) => {
  const { page, locate } = await open("form");
  const probe = `() => {
    if (window.__fixture !== undefined) throw new Error("The page's globals are visible.");
    globalThis.__recnrunLeak = true;
    return document.querySelector("form");
  }`;
  expect(await locate({ source: probe })).toMatchObject({ status: "matched", count: 1 });
  expect(await page.evaluate(() => window.__fixture?.ready)).toBe(true);
  expect(await page.evaluate(() => window.__recnrunLeak)).toBeUndefined();
});

test("a synchronous infinite loop is terminated and the tab still answers", async ({ open }) => {
  const { page, inspector, locate } = await open("form");
  const started = Date.now();
  const looped = await locate({ source: "() => { while (true) {} }", timeoutMs: 500 });
  const elapsed = Date.now() - started;
  console.log(`while(true) after ${elapsed} ms: ${JSON.stringify(looped)}`);
  expect(looped).toMatchObject({
    status: "error",
    error: { message: "The locator function did not finish within 500 ms." },
    deadline: { timeoutMs: 500, blocked: true, terminated: true, tabResponsive: true },
  });
  expect(elapsed).toBeLessThan(500 + 3 * 1_000);
  const { result } = await inspector.send("Runtime.evaluate", { expression: "1+1" });
  expect(result.value).toBe(2);
  await page.getByLabel("Name").fill("still alive");
  await expect(page.getByLabel("Name")).toHaveValue("still alive");
  expect(await locate({ source: INPUTS, cardinality: "many" })).toMatchObject({ count: 5 });
});

test("a promise that never settles is cut without terminating anything", async ({ open }) => {
  const { locate } = await open("form");
  const pending = await locate({ source: "() => new Promise(() => {})", timeoutMs: 300 });
  expect(pending).toMatchObject({
    status: "error",
    deadline: { timeoutMs: 300, blocked: false, terminated: false, tabResponsive: true },
  });
});
