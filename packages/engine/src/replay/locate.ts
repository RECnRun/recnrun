import type { Target } from "@recnrun/protocol";
import type { ElementState, ReplayDriver, TabList } from "./driver.ts";
import { failed, type StepOutcome } from "./outcome.ts";
import { pollUntil, readTimeout, type Deadline, type Poll } from "./wait.ts";

/** What an element must be before a step acts on it or reads it. */
export type Readiness = "attached" | "actionable" | "editable";

const READY: Readonly<Record<Readiness, (state: ElementState) => boolean>> = {
  attached: (state) => state.count === 1,
  actionable: (state) => state.count === 1 && state.visible && state.enabled,
  editable: (state) => state.count === 1 && state.visible && state.enabled && state.editable,
};

export type Located =
  | { ok: true; attempts: number; state: ElementState }
  | { ok: false; outcome: StepOutcome };

/** Says what a read saw, for the observed side of a failure. */
export function describeState(state: ElementState): string {
  if (state.count === 0) return "no element matches";
  if (state.count > 1) return `${state.count} elements match`;
  const traits = [
    state.visible ? "visible" : "hidden",
    state.enabled ? "enabled" : "disabled",
    ...(state.editable ? [] : ["not editable"]),
  ];
  return `one element, ${traits.join(", ")}`;
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)) || "Unknown error.";

/** The failure of a poll that never met its condition. */
export function unmet<T>(poll: Poll<T>, explain: (value: T) => StepOutcome): StepOutcome {
  // Every poll reads at least once, so without a value the reads threw.
  return poll.value === undefined
    ? failed("adapter-error", errorText("error" in poll ? poll.error : undefined))
    : explain(poll.value);
}

function notReady(state: ElementState, target: Target, deadline: Deadline): StepOutcome {
  const name = JSON.stringify(target);
  if (state.count > 1) return failed("ambiguous", `${name}: ${describeState(state)}.`);
  return failed(
    "timeout",
    `${name} was not ready within ${deadline.timeoutMs} ms: ${describeState(state)}.`,
  );
}

/** Polls the target until it is ready; locating is a read, so it may repeat until the deadline. */
export async function locate(
  driver: ReplayDriver,
  target: Target,
  readiness: Readiness,
  deadline: Deadline,
): Promise<Located> {
  const poll = await pollUntil(
    () => driver.inspect(target, readTimeout(deadline)),
    READY[readiness],
    deadline,
  );
  if (poll.met) return { ok: true, attempts: poll.attempts, state: poll.value };
  const outcome = unmet(poll, (state) => notReady(state, target, deadline));
  return { ok: false, outcome: { ...outcome, attempts: poll.attempts } };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Text equality ignoring runs of whitespace, as rendered text shows it. */
export function sameText(observed: string, expected: string): boolean {
  return normalize(observed) === normalize(expected);
}

export function containsText(observed: string, expected: string): boolean {
  return normalize(observed).includes(normalize(expected));
}

/** A URL matches when equal, or when `expected` has `*` wildcards that match any characters. */
export function urlMatches(url: string, expected: string): boolean {
  if (!expected.includes("*")) return url === expected;
  const pattern = expected
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(url);
}

export function currentUrl(list: TabList): string {
  return list.current === null ? "" : (list.tabs[list.current]?.url ?? "");
}

/**
 * The tab a `selectTab` query names: an index in opening order, or the one tab whose URL or
 * title equals the text, else the one that contains it. Undefined while none or several match.
 */
export function matchTab(list: TabList, query: number | string): number | undefined {
  if (typeof query === "number") return query < list.tabs.length ? query : undefined;
  const indexes = list.tabs.map((_, index) => index);
  const exact = indexes.filter((i) => [list.tabs[i]?.url, list.tabs[i]?.title].includes(query));
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const partial = indexes.filter((i) =>
    [list.tabs[i]?.url ?? "", list.tabs[i]?.title ?? ""].some((text) => text.includes(query)),
  );
  return partial.length === 1 ? partial[0] : undefined;
}
