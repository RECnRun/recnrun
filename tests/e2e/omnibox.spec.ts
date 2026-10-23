import type { BrowserContext, Page, Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../packages/domain/src/index.ts";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

type Disposition = "currentTab" | "newForegroundTab" | "newBackgroundTab";

interface Suggestion {
  content: string;
  description: string;
}

interface OmniboxEvent {
  hasListeners(): boolean;
}

interface ChromeGlobal {
  chrome: {
    runtime: { getURL(path: string): string };
    tabs: { query(filter: { url: string }): Promise<{ active: boolean; url?: string }[]> };
    omnibox: {
      onInputChanged: OmniboxEvent;
      onInputEntered: OmniboxEvent;
      setDefaultSuggestion(suggestion: { description: string }): Promise<void>;
    };
  };
  // Exposed by the service worker in test builds only; Playwright cannot type into the omnibox.
  recnrunOmnibox?: {
    inputChanged(text: string): Promise<{ defaultDescription: string; suggestions: Suggestion[] }>;
    inputEntered(text: string, disposition: Disposition): Promise<void>;
  };
}

/** The sample recordings plus one whose name needs XML escaping. */
function snapshotWithMarkup(): Snapshot {
  const snapshot = sampleSnapshot();
  return {
    ...snapshot,
    recordings: [
      ...snapshot.recordings,
      {
        id: "rec-markup",
        name: "Compare <&> prices",
        startUrl: "https://shop.example/compare?a=1&b=2",
        createdAt: "2026-10-03T08:00:00.000Z",
        durationMs: 4_000,
        eventCount: 1,
      },
    ],
  };
}

function inputChanged(serviceWorker: Worker, text: string) {
  return serviceWorker.evaluate(async (value) => {
    const omnibox = (globalThis as unknown as ChromeGlobal).recnrunOmnibox;
    if (!omnibox) throw new Error("The service worker does not expose the omnibox handlers.");
    return omnibox.inputChanged(value);
  }, text);
}

function inputEntered(serviceWorker: Worker, text: string, disposition: Disposition) {
  return serviceWorker.evaluate(
    async ([value, how]) => {
      const omnibox = (globalThis as unknown as ChromeGlobal).recnrunOmnibox;
      if (!omnibox) throw new Error("The service worker does not expose the omnibox handlers.");
      await omnibox.inputEntered(value, how);
    },
    [text, disposition] as const,
  );
}

/** Chrome's own parser rejects descriptions that are not well-formed omnibox XML. */
function chromeAcceptsDescription(serviceWorker: Worker, description: string) {
  return serviceWorker.evaluate(
    (value) =>
      (globalThis as unknown as ChromeGlobal).chrome.omnibox
        .setDefaultSuggestion({ description: value })
        .then(
          () => "accepted",
          (error: unknown) => String(error),
        ),
    description,
  );
}

function dashboardBase(serviceWorker: Worker): string {
  return new URL("dashboard.html", serviceWorker.url()).href;
}

function dashboardPages(context: BrowserContext, serviceWorker: Worker): Page[] {
  const base = dashboardBase(serviceWorker);
  return context.pages().filter((page) => page.url().split("#")[0] === base);
}

/** Playwright emulates focus, so Chrome's tab state is the truth for which tab is active. */
function dashboardTabsActive(serviceWorker: Worker): Promise<boolean[]> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") });
    return tabs.map((tab) => tab.active);
  });
}

async function onlyDashboard(context: BrowserContext, serviceWorker: Worker): Promise<Page> {
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  const [dashboard] = dashboardPages(context, serviceWorker);
  if (!dashboard) throw new Error("The dashboard tab did not open.");
  return dashboard;
}

test("declares the rr omnibox keyword without new permissions", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.omnibox).toEqual({ keyword: "rr" });
  expect(manifest.permissions).toEqual(["storage", "contextMenus"]);
});

test("registers the omnibox listeners when the service worker starts", async ({
  serviceWorker,
}) => {
  const registered = await serviceWorker.evaluate(() => {
    const { omnibox } = (globalThis as unknown as ChromeGlobal).chrome;
    return [omnibox.onInputChanged.hasListeners(), omnibox.onInputEntered.hasListeners()];
  });
  expect(registered).toEqual([true, true]);
});

test("suggests stored recordings whose names match the typed text", async ({
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(snapshotWithMarkup());

  const { defaultDescription, suggestions } = await inputChanged(serviceWorker, "CHECK");
  expect(defaultDescription).toBe("Search RECnRun recordings for <match>CHECK</match>");
  expect(suggestions).toEqual([
    {
      content: "rec:rec-checkout",
      description:
        "<match>Check</match>out with saved card <dim>· 31 events</dim> <url>https://staging.shop.example/cart</url>",
    },
  ]);

  const all = await inputChanged(serviceWorker, "");
  expect(all.defaultDescription).toBe("Open the RECnRun dashboard");
  expect(all.suggestions.map((suggestion) => suggestion.content)).toEqual([
    "rec:rec-markup",
    "rec:rec-checkout",
    "rec:rec-login",
  ]);
});

test("escapes markup in recording names and typed text", async ({
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(snapshotWithMarkup());

  const { defaultDescription, suggestions } = await inputChanged(serviceWorker, "<&>");
  expect(defaultDescription).toBe("Search RECnRun recordings for <match>&lt;&amp;&gt;</match>");
  expect(suggestions).toEqual([
    {
      content: "rec:rec-markup",
      description:
        "Compare <match>&lt;&amp;&gt;</match> prices <dim>· 1 event</dim> <url>https://shop.example/compare?a=1&amp;b=2</url>",
    },
  ]);
  for (const description of [defaultDescription, ...suggestions.map((s) => s.description)]) {
    expect(await chromeAcceptsDescription(serviceWorker, description)).toBe("accepted");
  }
});

test("Enter on rr alone opens the dashboard in the current tab, then focuses it", async ({
  context,
  serviceWorker,
}) => {
  const current = await context.newPage();
  await current.goto("about:blank");
  await current.bringToFront();

  await inputEntered(serviceWorker, "", "currentTab");
  await expect(current).toHaveURL(dashboardBase(serviceWorker));
  await expect(current.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();

  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([false]);

  await inputEntered(serviceWorker, "", "currentTab");
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([true]);
  expect(other.url()).toBe("about:blank");
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("Alt+Enter and background dispositions open new dashboard tabs", async ({ serviceWorker }) => {
  await inputEntered(serviceWorker, "", "newBackgroundTab");
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([false]);
  await inputEntered(serviceWorker, "", "newForegroundTab");
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([false, true]);
});

test("choosing a suggestion deep-links the dashboard to that recording", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(snapshotWithMarkup());
  const [checkout] = (await inputChanged(serviceWorker, "checkout")).suggestions;
  if (!checkout) throw new Error("No suggestion for checkout.");

  await inputEntered(serviceWorker, checkout.content, "newForegroundTab");
  const dashboard = await onlyDashboard(context, serviceWorker);
  await expect(dashboard).toHaveURL(`${dashboardBase(serviceWorker)}#/recordings/rec-checkout`);
  await expect(dashboard.getByRole("status")).toHaveText("Showing “Checkout with saved card”");
  await expect(
    dashboard.getByRole("article", { name: "Checkout with saved card" }),
  ).toHaveAttribute("aria-current", "true");

  const [markup] = (await inputChanged(serviceWorker, "<&>")).suggestions;
  if (!markup) throw new Error("No suggestion for <&>.");
  await inputEntered(serviceWorker, markup.content, "currentTab");
  await expect(dashboard).toHaveURL(`${dashboardBase(serviceWorker)}#/recordings/rec-markup`);
  await expect(dashboard.getByRole("article", { name: "Compare <&> prices" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    dashboard.getByRole("article", { name: "Checkout with saved card" }),
  ).not.toHaveAttribute("aria-current", "true");
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("Enter on free text opens the dashboard filtered by that text", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(snapshotWithMarkup());
  await inputEntered(serviceWorker, "  log ", "newForegroundTab");

  const dashboard = await onlyDashboard(context, serviceWorker);
  await expect(dashboard).toHaveURL(`${dashboardBase(serviceWorker)}#/search/log`);
  await expect(dashboard.getByRole("status")).toHaveText("1 recording matches “log”");
  await expect(dashboard.getByRole("article")).toHaveCount(1);
  await expect(dashboard.getByRole("article", { name: "Log in as admin" })).toBeVisible();
});
