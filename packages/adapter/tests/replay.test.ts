import type { Target } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { createPageDriver, type ReplayPage } from "../src/replay.ts";

/** A Playwright page stand-in that records which locator each target became and what ran on it. */
function fakePage(text: string | null = "Submitted Ada") {
  const calls: string[] = [];
  const locator = (made: string) => ({
    fill: (value: string, options: unknown) =>
      void calls.push(`${made}.fill ${value} ${JSON.stringify(options)}`),
    click: (options: unknown) => void calls.push(`${made}.click ${JSON.stringify(options)}`),
    textContent: (options: unknown) => {
      calls.push(`${made}.textContent ${JSON.stringify(options)}`);
      return Promise.resolve(text);
    },
  });
  const by =
    (kind: string) =>
    (...args: unknown[]) =>
      locator(`${kind}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
  const page = {
    goto: (url: string, options: unknown) =>
      void calls.push(`goto ${url} ${JSON.stringify(options)}`),
    getByTestId: by("getByTestId"),
    getByRole: by("getByRole"),
    getByText: by("getByText"),
    getByLabel: by("getByLabel"),
    locator: by("locator"),
  };
  return { page: page as unknown as ReplayPage, calls };
}

const WAIT = '{"timeout":10000}';

describe("createPageDriver", () => {
  test.each<[Target, string]>([
    ["#name", 'locator("#name")'],
    [{ testId: "status" }, 'getByTestId("status")'],
    [
      { role: "button", name: "Submit", exact: true },
      'getByRole("button", {"name":"Submit","exact":true})',
    ],
    [{ role: "status" }, 'getByRole("status", {})'],
    [{ text: "Submitted", exact: false }, 'getByText("Submitted", {"exact":false})'],
    [{ label: "Name" }, 'getByLabel("Name", {})'],
    [{ css: "form input" }, 'locator("form input")'],
    [{ xpath: "//input" }, 'locator("xpath=//input")'],
  ])("clicks %j through %s", async (target, made) => {
    const { page, calls } = fakePage();
    await createPageDriver(async () => page).click(target);
    expect(calls).toEqual([`${made}.click ${WAIT}`]);
  });

  test("navigates, fills, and reads text on the same page", async () => {
    const { page, calls } = fakePage();
    let opened = 0;
    const driver = createPageDriver(async () => {
      opened += 1;
      return page;
    });
    await driver.navigate("http://127.0.0.1:4600/routes/form");
    await driver.fill({ label: "Name" }, "Ada");
    expect(await driver.readText({ testId: "status" })).toBe("Submitted Ada");
    expect(calls).toEqual([
      `goto http://127.0.0.1:4600/routes/form ${WAIT}`,
      `getByLabel("Name", {}).fill Ada ${WAIT}`,
      `getByTestId("status").textContent ${WAIT}`,
    ]);
    expect(opened).toBe(1);
  });

  test("opens the page again on the next action after opening failed", async () => {
    const { page, calls } = fakePage();
    const opens = [Promise.reject(new Error("No tab.")), Promise.resolve(page)];
    const driver = createPageDriver(() => opens.shift() ?? Promise.resolve(page));
    await expect(driver.navigate("http://127.0.0.1:4600/")).rejects.toThrow("No tab.");
    await driver.navigate("http://127.0.0.1:4600/");
    expect(calls).toEqual([`goto http://127.0.0.1:4600/ ${WAIT}`]);
    expect(opens).toEqual([]);
  });

  test("an element without text reads as an empty string", async () => {
    const { page } = fakePage(null);
    expect(await createPageDriver(async () => page).readText({ testId: "status" })).toBe("");
  });

  test.each<[string, Target]>([
    ["a locator list", { locators: [{ testId: "status" }] } as Target],
    ["an explicit strategy", { strategy: "testId", value: "status" }],
    ["a function locator", { functionRef: "team.status@1.0.0" }],
  ])("rejects %s as unsupported by the spike", async (_name, target) => {
    const { page, calls } = fakePage();
    await expect(createPageDriver(async () => page).click(target)).rejects.toThrow(
      /not supported by the replay spike/,
    );
    expect(calls).toEqual([]);
  });
});
