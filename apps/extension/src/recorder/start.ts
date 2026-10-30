import { browser } from "wxt/browser";
import { createEventRecorder } from "./events.ts";

const MARK = "__recnrunRecorder";
const DEBOUNCE_MS = 300;

/** Runs inside the user's application; it only reports steps to the background. */
export function startRecorder(): void {
  // The script is both registered and injected into open tabs, so a tab may load it twice.
  const marked = globalThis as unknown as Record<string, boolean | undefined>;
  if (marked[MARK]) return;
  marked[MARK] = true;
  createEventRecorder(
    (step) => {
      browser.runtime.sendMessage({ kind: "step", step }).catch(() => undefined);
    },
    { now: () => new Date(), url: () => location.href, debounceMs: DEBOUNCE_MS },
  ).attach(document);
}
