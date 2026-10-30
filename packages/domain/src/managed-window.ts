import * as v from "valibot";
import { IdSchema } from "./ids.ts";

const BrowserIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * The Incognito session RECnRun opened, by the window and tab it opened first; it stays active
 * while any Incognito window is open, since every one shares the session's profile.
 */
export const ManagedWindowStateSchema = v.object({
  /** Counts the windows RECnRun opened, so a late message from an older one is told apart. */
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  windowId: BrowserIdSchema,
  tabId: BrowserIdSchema,
  status: v.picklist(["active", "closed"]),
  /** The saved identity the window holds; none for a window started without one. */
  identityId: v.optional(IdSchema),
});

export type ManagedWindowState = v.InferOutput<typeof ManagedWindowStateSchema>;

/** The part of a browser window the inventory rules read. */
export interface IncognitoWindowShape {
  id: number;
  incognito: boolean;
  type?: string;
}

/** DevTools windows close with their page; any other one, a Document PiP included, keeps the Incognito session alive. */
function isIncognitoBrowsingWindow(window: IncognitoWindowShape): boolean {
  return window.incognito && window.type !== "devtools";
}

/**
 * Splits the Incognito windows: while RECnRun's session is active, every one belongs to it, since
 * Chrome shares one Incognito profile; without one, every one is foreign.
 */
export function classifyIncognitoWindows<W extends IncognitoWindowShape>(
  windows: readonly W[],
  managed: ManagedWindowState | undefined,
): { session: W[]; foreign: W[] } {
  const incognito = windows.filter(isIncognitoBrowsingWindow);
  return managed?.status === "active"
    ? { session: incognito, foreign: [] }
    : { session: [], foreign: incognito };
}

// The scheme is checked on the raw text, so leading spaces the URL parser would strip are refused.
export const TargetUrlSchema = v.pipe(v.string(), v.url(), v.regex(/^https?:\/\//i));

/** Only web pages may be recorded or run; browser-internal pages are temporary workspace pages. */
export function isAllowedTarget(url: string): boolean {
  return v.is(TargetUrlSchema, url);
}
