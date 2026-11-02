import type { Target } from "@recnrun/protocol";
import type { Locator, Page } from "playwright-core";

/** The part of a Playwright page replay drives; unit tests fake it. */
export type ReplayPage = Pick<
  Page,
  | "goto"
  | "reload"
  | "getByTestId"
  | "getByRole"
  | "getByText"
  | "getByLabel"
  | "locator"
  | "url"
  | "title"
  | "bringToFront"
  | "close"
  | "isClosed"
  | "on"
  | "keyboard"
>;

type AriaRole = Parameters<Page["getByRole"]>[0];
// The one-key forms replay resolves; locator lists, strategies, and functions come with F3.
type Shorthand = Exclude<
  Target,
  string | { strategy: string } | { locators: unknown } | { functionRef: string }
>;

const exactness = (exact: boolean | undefined) => (exact === undefined ? {} : { exact });

function unsupported(target: Target): Error {
  return new Error(`The locator ${JSON.stringify(target)} is not supported by replay yet.`);
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
export function locate(page: ReplayPage, target: Target): Locator {
  if (typeof target === "string") return page.locator(target);
  if ("strategy" in target || "locators" in target || "functionRef" in target) {
    throw unsupported(target);
  }
  return byShorthand(page, target);
}

/** Playwright reads a timeout of 0 as "no timeout", so every call gets at least 1 ms. */
export const playwrightTimeout = (ms: number): number => Math.max(1, Math.round(ms));
