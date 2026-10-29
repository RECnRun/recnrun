import * as v from "valibot";
import { TargetUrlSchema } from "./managed-window.ts";
import { OriginDataSchema, OriginSchema } from "./origin-data.ts";

const IndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** One origin's sessionStorage as one tab held it; another tab of the origin holds its own. */
const TabSessionSchema = v.object({
  origin: OriginSchema,
  entries: OriginDataSchema.entries.sessionStorage,
});

const LayoutTabSchema = v.pipe(
  v.object({
    url: TargetUrlSchema,
    active: v.boolean(),
    sessionStorage: v.array(TabSessionSchema),
  }),
  v.check(
    ({ sessionStorage }) =>
      new Set(sessionStorage.map(({ origin }) => origin)).size === sessionStorage.length,
    "Repeated origin in a tab's sessionStorage.",
  ),
);

const LayoutWindowSchema = v.pipe(
  v.object({ focused: v.boolean(), tabs: v.pipe(v.array(LayoutTabSchema), v.minLength(1)) }),
  v.check(({ tabs }) => tabs.filter(({ active }) => active).length <= 1, "Two active tabs."),
);

/**
 * Every Incognito window a capture saved, in order, each with its tabs in order, and where the
 * capture's own target sits: its window and its place there. The URLs stay in the capture; they
 * are never logged or sent over the website bridge.
 */
export const SessionLayoutSchema = v.pipe(
  v.object({
    windows: v.pipe(v.array(LayoutWindowSchema), v.minLength(1)),
    primary: v.object({ window: IndexSchema, tab: IndexSchema }),
  }),
  v.check(
    ({ windows, primary }) => windows[primary.window]?.tabs[primary.tab] !== undefined,
    "The primary tab is not in the layout.",
  ),
  v.check(
    ({ windows }) => windows.filter(({ focused }) => focused).length <= 1,
    "Two focused windows.",
  ),
);

export type SessionLayout = v.InferOutput<typeof SessionLayoutSchema>;

/** The tab a start opens first: the capture's target. */
export function primaryTab({ windows, primary }: SessionLayout) {
  const tab = windows[primary.window]?.tabs[primary.tab];
  if (tab === undefined) throw new Error("The layout names no primary tab.");
  return tab;
}
