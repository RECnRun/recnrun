import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ROUTES } from "../../../apps/fixture/src/routes.ts";
import { expect, test as chromeTest } from "./chrome.ts";

export { expect };

/** The ports `playwright.browser.config.ts` starts the fixture on. */
export const FIXTURE_ORIGIN = "http://127.0.0.1:4600";
export const SECOND_ORIGIN = "http://localhost:4601";
export const ROUTE_NAMES = ROUTES.map(({ name }) => name);

export interface FixtureState {
  route: string;
  ready: boolean;
  counters: Record<string, number>;
  fail: string;
  loadId: string;
  /** Whether page instrumentation had run when the page's first script did. */
  hookSeenAtHead: boolean;
}

declare global {
  interface Window {
    __fixture?: FixtureState;
  }
}

export interface FixtureApp {
  browser: Browser;
  context: BrowserContext;
  /** Opens `/routes/<route>` (or `/` for `index`) in a new tab and waits for its self-test. */
  open(route: string, query?: string): Promise<Page>;
}

export async function waitReady(page: Page, route: string): Promise<void> {
  await page.waitForFunction(() => window.__fixture?.ready === true, undefined, {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => window.__fixture?.route)).toBe(route);
}

export function state(page: Page): Promise<FixtureState | undefined> {
  return page.evaluate(() => window.__fixture);
}

export async function counters(page: Page): Promise<Record<string, number>> {
  return (await state(page))?.counters ?? {};
}

export const test = chromeTest.extend<{ app: FixtureApp }>({
  app: async ({ chrome }, use) => {
    const browser = await chromium.connectOverCDP(chrome.wsEndpoint);
    try {
      const [context = await browser.newContext()] = browser.contexts();
      const open = async (route: string, query = ""): Promise<Page> => {
        const page = await context.newPage();
        const path = route === "index" ? "/" : `/routes/${route}`;
        await page.goto(`${FIXTURE_ORIGIN}${path}${query}`);
        await waitReady(page, route);
        return page;
      };
      await use({ browser, context, open });
    } finally {
      await browser.close();
    }
  },
});

export const FORM_STATUS = "Submitted Ada Lovelace (pro, email, terms accepted, notes.txt)";

/** Fills every control of the form route and submits it. */
export async function submitForm(page: Page): Promise<void> {
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Plan").selectOption("pro");
  await page.getByLabel("Accept the terms").check();
  await page.getByLabel("Email").check();
  await page.getByLabel("Attachment").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await page.getByRole("button", { name: "Submit" }).click();
}

/** Types a composition through Chrome's IME input path, as an input method would. */
export async function compose(page: Page, text: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  await session.send("Input.insertText", { text });
  await session.detach();
}

/** Clicks a network button and returns its result text once it settles. */
export async function networkResult(page: Page, name: string): Promise<string> {
  await page.getByTestId(`fetch-${name}`).click();
  const result = page.getByTestId(`result-${name}`);
  await expect(result).not.toHaveText(/^(|pending)$/, { timeout: 15_000 });
  return (await result.textContent()) ?? "";
}
