import type { ActResult, DriverCommand } from "@recnrun/engine";
import type { Locator } from "playwright-core";
import { locate, playwrightTimeout, within } from "./replay-page.ts";
import type { ReplayTabs } from "./replay-tabs.ts";

type Command<K extends DriverCommand["kind"]> = Extract<DriverCommand, { kind: K }>;

/** Runs a trial whose input the replay's capture must not journal, for at most `ms`. */
export type Unobserved = <T>(work: () => Promise<T>, ms: number) => Promise<T>;

/** One write's budget: every Playwright call in it shares the same end. */
interface Budget {
  left(): number;
  unobserved: Unobserved;
}

type Handler<K extends DriverCommand["kind"]> = (
  tabs: ReplayTabs,
  command: Command<K>,
  budget: Budget,
) => Promise<ActResult>;

const DONE: ActResult = { status: "done" };

// Waiting for `load`, never `networkidle`: a page that keeps polling would never settle.
const LOAD = "load" as const;

// Playwright appends a multi-line call log with terminal colors; steps.json keeps the first line.
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ||
  "Unknown error.";

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && error.name === "TimeoutError";

/** An error before anything reached the page: safe to report as a plain failure. */
function notDispatched(error: unknown): ActResult {
  const message = messageOf(error);
  if (isTimeout(error)) return { status: "not-dispatched", code: "timeout", message };
  if (message.includes("strict mode violation")) {
    return { status: "not-dispatched", code: "ambiguous", message };
  }
  return { status: "not-dispatched", code: "adapter-error", message };
}

/** An error after the write was dispatched: only a refused navigation has a known effect. */
function dispatched(error: unknown): ActResult {
  const message = messageOf(error);
  if (/net::ERR_/.test(message)) return { status: "failed", code: "navigation-failed", message };
  return { status: "unknown", code: isTimeout(error) ? "timeout" : "adapter-error", message };
}

async function attempt(work: () => Promise<unknown>): Promise<ActResult> {
  try {
    await work();
    return DONE;
  } catch (error) {
    return dispatched(error);
  }
}

/**
 * Checks actionability with a trial first, so a refusal is known not to have reached the page.
 * The trial dispatches real input that Playwright's hit-target interceptor stops before the page
 * handles it, so the capture is muted while it runs.
 */
async function press(locator: Locator, kind: "click" | "check" | "uncheck", budget: Budget) {
  try {
    const timeout = budget.left();
    await budget.unobserved(() => locator[kind]({ trial: true, timeout }), timeout);
  } catch (error) {
    return notDispatched(error);
  }
  return attempt(() => locator[kind]({ timeout: budget.left() }));
}

const pressHandler: Handler<"click" | "check" | "uncheck"> = async (tabs, command, budget) =>
  press(locate(await tabs.current(), command.target), command.kind, budget);

async function select(locator: Locator, value: string, budget: Budget): Promise<ActResult> {
  const has = await locator.evaluate(
    (element, wanted) =>
      element.tagName === "SELECT" &&
      [...element.options].some(
        (option: { value: string; label: string }) =>
          option.value === wanted || option.label === wanted,
      ),
    value,
    { timeout: budget.left() },
  );
  if (!has) {
    const message = `The select has no option ${JSON.stringify(value)}.`;
    return { status: "not-dispatched", code: "not-actionable", message };
  }
  return attempt(() => locator.selectOption(value, { timeout: budget.left() }));
}

const inputHandler: Handler<"fill" | "type" | "select"> = async (tabs, command, budget) => {
  const locator = locate(await tabs.current(), command.target);
  if (command.kind === "select") return select(locator, command.value, budget);
  if (command.kind === "type") {
    return attempt(() => locator.pressSequentially(command.value, { timeout: budget.left() }));
  }
  return attempt(() => locator.fill(command.value, { timeout: budget.left() }));
};

const keyPress: Handler<"keyPress"> = async (tabs, command, budget) => {
  const page = await tabs.current();
  if (!command.target) return attempt(() => page.keyboard.press(command.key));
  const locator = locate(page, command.target);
  return attempt(() => locator.press(command.key, { timeout: budget.left() }));
};

const scroll: Handler<"scroll"> = async (tabs, { target, deltaX, deltaY }, budget) => {
  const page = await tabs.current();
  const by: [number, number] = [deltaX, deltaY];
  if (!target) {
    const root = page.locator(":root");
    const options = { timeout: budget.left() };
    return attempt(() =>
      root.evaluate(
        (element, [x, y]) => element.ownerDocument.defaultView.scrollBy(x, y),
        by,
        options,
      ),
    );
  }
  const locator = locate(page, target);
  if (deltaX === 0 && deltaY === 0) {
    return attempt(() => locator.scrollIntoViewIfNeeded({ timeout: budget.left() }));
  }
  const options = { timeout: budget.left() };
  return attempt(() => locator.evaluate((element, [x, y]) => element.scrollBy(x, y), by, options));
};

const HANDLERS: { [K in DriverCommand["kind"]]: Handler<K> } = {
  navigate: async (tabs, { url }, budget) => {
    const page = await tabs.current();
    return attempt(() => page.goto(url, { waitUntil: LOAD, timeout: budget.left() }));
  },
  reload: async (tabs, _command, budget) => {
    const page = await tabs.current();
    return attempt(() => page.reload({ waitUntil: LOAD, timeout: budget.left() }));
  },
  click: (tabs, command, budget) => pressHandler(tabs, command, budget),
  check: (tabs, command, budget) => pressHandler(tabs, command, budget),
  uncheck: (tabs, command, budget) => pressHandler(tabs, command, budget),
  fill: (tabs, command, budget) => inputHandler(tabs, command, budget),
  type: (tabs, command, budget) => inputHandler(tabs, command, budget),
  select: (tabs, command, budget) => inputHandler(tabs, command, budget),
  keyPress,
  scroll,
  openTab: async (tabs, { url }, budget) => {
    const page = await tabs.open();
    if (url === undefined) return DONE;
    return attempt(() => page.goto(url, { waitUntil: LOAD, timeout: budget.left() }));
  },
  selectTab: async (tabs, { index }) => {
    if (await tabs.select(index)) return DONE;
    const message = `No replay tab is open at index ${index}.`;
    return { status: "not-dispatched", code: "adapter-error", message };
  },
  closeTab: async (tabs) => attempt(() => tabs.close()),
};

/** Dispatches one command once; a thrown error never leads to a second dispatch. */
export async function act(
  tabs: ReplayTabs,
  command: DriverCommand,
  timeoutMs: number,
  unobserved: Unobserved = async (work) => work(),
): Promise<ActResult> {
  const end = Date.now() + timeoutMs;
  const budget: Budget = { left: () => playwrightTimeout(end - Date.now()), unobserved };
  const handler = HANDLERS[command.kind] as Handler<DriverCommand["kind"]>;
  const handled = handler(tabs, command as never, budget).catch(
    // Opening the tab or resolving the locator threw before the write began.
    (error: unknown) => notDispatched(error),
  );
  // Opening, switching, and closing tabs and pressing a page key take no timeout of their own.
  return within(handled, timeoutMs, () => ({
    status: "unknown",
    code: "timeout",
    message: `The ${command.kind} did not answer within ${timeoutMs} ms; its effect is unknown.`,
  }));
}
