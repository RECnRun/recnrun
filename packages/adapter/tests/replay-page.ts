import type { ReplayPage } from "../src/replay.ts";

export interface FakePageOptions {
  url?: string;
  title?: string;
  /** How many elements every locator matches. */
  count?: number;
  /** Errors by method; a trial click is `click:trial`. */
  fail?: Record<string, Error>;
  /** What `evaluate` returns, such as whether a select has an option. */
  evaluates?: unknown;
}

export function timeoutError(message = "Timeout 100ms exceeded."): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

type Listener = (page: unknown) => void;

/** A Playwright page stand-in that records which locator each target became and what ran on it. */
export function fakePage(options: FakePageOptions = {}, calls: string[] = []) {
  const listeners: Record<string, Listener[]> = {};
  let closed = false;
  let url = options.url ?? "about:blank";
  const run = (key: string, line: string, result: unknown) => {
    calls.push(line);
    const error = options.fail?.[key];
    return error ? Promise.reject(error) : Promise.resolve(result);
  };
  const method =
    (made: string, name: string, result?: unknown) =>
    (...args: unknown[]) => {
      const trial = args.some((arg) => typeof arg === "object" && arg !== null && "trial" in arg);
      const shown = args
        .filter((arg) => typeof arg !== "function")
        .map((arg) => JSON.stringify(arg));
      return run(
        trial ? `${name}:trial` : name,
        `${made}.${name} ${shown.join(" ")}`.trim(),
        result,
      );
    };
  const locator = (made: string) => ({
    count: () => Promise.resolve(options.count ?? 1),
    isVisible: method(made, "isVisible", true),
    isEnabled: method(made, "isEnabled", true),
    isEditable: method(made, "isEditable", true),
    textContent: method(made, "textContent", "Text"),
    inputValue: method(made, "inputValue", "Value"),
    getAttribute: method(made, "getAttribute", "attr"),
    evaluate: method(made, "evaluate", options.evaluates ?? true),
    ...Object.fromEntries(
      ["click", "check", "uncheck", "fill", "pressSequentially", "selectOption", "press"].map(
        (name) => [name, method(made, name)],
      ),
    ),
    scrollIntoViewIfNeeded: method(made, "scrollIntoViewIfNeeded"),
  });
  const by =
    (kind: string) =>
    (...args: unknown[]) =>
      locator(`${kind}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
  const page = {
    goto: (to: string, opts: unknown) => {
      url = to;
      return run("goto", `goto ${to} ${JSON.stringify(opts)}`, null);
    },
    reload: (opts: unknown) => run("reload", `reload ${JSON.stringify(opts)}`, null),
    getByTestId: by("getByTestId"),
    getByRole: by("getByRole"),
    getByText: by("getByText"),
    getByLabel: by("getByLabel"),
    locator: by("locator"),
    url: () => url,
    title: () => {
      const error = options.fail?.title;
      return error ? Promise.reject(error) : Promise.resolve(options.title ?? "");
    },
    bringToFront: () => run("bringToFront", `bringToFront ${url}`, undefined),
    close: () => {
      closed = true;
      for (const listener of listeners.close ?? []) listener(page);
      return run("close", `close ${url}`, undefined);
    },
    isClosed: () => closed,
    on: (event: string, listener: Listener) => {
      (listeners[event] ??= []).push(listener);
      return page;
    },
    keyboard: { press: (key: string) => run("keyboard.press", `keyboard.press ${key}`, undefined) },
    /** Fires `popup` as Chrome would when the page opens a window. */
    popup: (other: unknown) => {
      for (const listener of listeners.popup ?? []) listener(other);
    },
  };
  return { page: page as unknown as ReplayPage & { popup(other: unknown): void }, calls };
}
