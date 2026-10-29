import * as v from "valibot";
import { TargetUrlSchema } from "./managed-window.ts";
import { OriginDataSchema, OriginSchema } from "./origin-data.ts";

const IndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** One origin's sessionStorage as one tab held it; another tab of the origin holds its own. */
const TabSessionSchema = v.object({
  origin: OriginSchema,
  entries: OriginDataSchema.entries.sessionStorage,
});

/** Pages a start reopens as Chrome opens them, empty: a blank tab and the New Tab page. */
export const PLAIN_PAGES = ["about:blank", "chrome://newtab/"] as const;

/** Whether `url` is a page a start reopens empty rather than loads. */
export const isPlainPage = (url: string): url is (typeof PLAIN_PAGES)[number] =>
  (PLAIN_PAGES as readonly string[]).includes(url);

const LayoutTabSchema = v.pipe(
  v.object({
    url: v.union([TargetUrlSchema, v.picklist(PLAIN_PAGES)]),
    active: v.boolean(),
    sessionStorage: v.array(TabSessionSchema),
  }),
  v.check(
    ({ url, sessionStorage }) => !isPlainPage(url) || sessionStorage.length === 0,
    "A blank or New Tab page holds no sessionStorage.",
  ),
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
 * Every Incognito window a capture saved, in order, each with its tabs in order (a web page, a blank
 * tab, or the New Tab page), and where the
 * capture's own target sits: its window and its place there. The URLs stay in the capture; they
 * are never logged or sent over the website bridge.
 */
export const SessionLayoutSchema = v.pipe(
  v.object({
    windows: v.pipe(v.array(LayoutWindowSchema), v.minLength(1)),
    primary: v.object({ window: IndexSchema, tab: IndexSchema }),
  }),
  v.check(({ windows, primary }) => {
    const tab = windows[primary.window]?.tabs[primary.tab];
    return tab !== undefined && !isPlainPage(tab.url);
  }, "The primary tab is not a web page in the layout."),
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
