import type { ReplayDriver } from "@recnrun/engine";
import type { Target } from "@recnrun/protocol";
import type { Locator, Page } from "playwright-core";

/** The part of a Playwright page the replay spike drives; unit tests fake it. */
export type ReplayPage = Pick<
  Page,
  "goto" | "getByTestId" | "getByRole" | "getByText" | "getByLabel" | "locator"
>;

type AriaRole = Parameters<Page["getByRole"]>[0];
// The one-key forms the spike resolves; locator lists, strategies, and functions come later.
type Shorthand = Exclude<
  Target,
  string | { strategy: string } | { locators: unknown } | { functionRef: string }
>;

// Playwright's own actionability waits run under this bound; per-step timeouts come with F2.5.
const ACTION_TIMEOUT_MS = 10_000;
const WAIT = { timeout: ACTION_TIMEOUT_MS };

const exactness = (exact: boolean | undefined) => (exact === undefined ? {} : { exact });

function unsupported(target: Target): Error {
  return new Error(`The locator ${JSON.stringify(target)} is not supported by the replay spike.`);
}

function byShorthand(page: ReplayPage, target: Shorthand): Locator {
  if ("testId" in target) return page.getByTestId(target.testId);
  if ("role" in target) {
    const name = target.name === undefined ? {} : { name: target.name };
    return page.getByRole(target.role as AriaRole, { ...name, ...exactness(target.exact) });
  }
  if ("text" in target) return page.getByText(target.text, exactness(target.exact));
  if ("label" in target) return page.getByLabel(target.label, exactness(target.exact));
  if ("css" in target) return page.locator(target.css);
  return page.locator(`xpath=${target.xpath}`);
}

/** Maps a CSS string or a one-key shorthand to a Playwright locator, which is strict on ambiguity. */
function locate(page: ReplayPage, target: Target): Locator {
  if (typeof target === "string") return page.locator(target);
  if ("strategy" in target || "locators" in target || "functionRef" in target) {
    throw unsupported(target);
  }
  return byShorthand(page, target);
}

/**
 * Drives one page through Playwright's input methods, so Chrome dispatches trusted events;
 * the page is opened on the first action. `open` failing leaves the next action to retry it.
 */
export function createPageDriver(open: () => Promise<ReplayPage>): ReplayDriver {
  let page: Promise<ReplayPage> | undefined;
  const current = (): Promise<ReplayPage> => {
    page ??= open().catch((error: unknown) => {
      page = undefined;
      throw error;
    });
    return page;
  };
  return {
    async navigate(url) {
      await (await current()).goto(url, WAIT);
    },
    async fill(target, value) {
      await locate(await current(), target).fill(value, WAIT);
    },
    async click(target) {
      await locate(await current(), target).click(WAIT);
    },
    async readText(target) {
      return (await locate(await current(), target).textContent(WAIT)) ?? "";
    },
  };
}
