import type { ElementState, PageCapture, ReplayDriver } from "@recnrun/engine";
import type { Locator } from "playwright-core";
import { act } from "./replay-act.ts";
import { capturePage } from "./replay-capture.ts";
import { locate, playwrightTimeout, type ReplayPage } from "./replay-page.ts";
import { createTabs } from "./replay-tabs.ts";

export type { ReplayPage } from "./replay-page.ts";

const NONE: ElementState = {
  count: 0,
  visible: false,
  enabled: false,
  editable: false,
  text: "",
  value: null,
};

// Elements that are not inputs throw on these reads; that is an answer, not an error.
const orFalse = (read: Promise<boolean>) => read.catch(() => false);
const orNull = (read: Promise<string>) => read.catch(() => null);

async function readState(locator: Locator, timeoutMs: number): Promise<ElementState> {
  const count = await locator.count();
  if (count !== 1) return { ...NONE, count };
  const timeout = playwrightTimeout(timeoutMs);
  const [visible, enabled, editable, text, value] = await Promise.all([
    locator.isVisible(),
    locator.isEnabled({ timeout }),
    orFalse(locator.isEditable({ timeout })),
    locator.textContent({ timeout }),
    orNull(locator.inputValue({ timeout })),
  ]);
  return { count, visible, enabled, editable, text: text ?? "", value };
}

/** Every driver method but `onEvent` and `onCapture`, which the adapter answers from its connection. */
export type PageDriver = Required<Omit<ReplayDriver, "onEvent" | "onCapture">>;

/**
 * Drives the replay's tabs through Playwright's input methods, so Chrome dispatches trusted
 * events. Reads never open a tab; the first write opens one in the default browser context.
 */
export function createPageDriver(open: () => Promise<ReplayPage>): PageDriver {
  const tabs = createTabs(open);
  const onPage = <T>(absent: T, read: (page: ReplayPage) => Promise<T>): Promise<T> => {
    const page = tabs.selected();
    return page ? read(page) : Promise.resolve(absent);
  };
  return {
    inspect: (target, { timeoutMs }) =>
      onPage(NONE, async (page) => readState(locate(page, target), timeoutMs)),
    readAttribute: (target, name, { timeoutMs }) =>
      onPage(null, async (page) => {
        const locator = locate(page, target);
        if ((await locator.count()) !== 1) return null;
        return locator.getAttribute(name, { timeout: playwrightTimeout(timeoutMs) });
      }),
    tabs: ({ timeoutMs }) => tabs.list(timeoutMs),
    act: (command, { timeoutMs }) => act(tabs, command, timeoutMs),
    capture: ({ timeoutMs }) =>
      onPage<PageCapture>({ tab: false }, (page) => capturePage(page, timeoutMs)),
  };
}
