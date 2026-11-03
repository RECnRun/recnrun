import { OriginalProbe } from "@/background/original/probe";
import type { InjectionApi } from "@/background/original/probe";

/** What the harness reaches with `Runtime.evaluate` in this service worker (P1.7). */
export const ORIGINAL_GLOBAL = "recnrunOriginal";

export function exposeOriginal(scripting: () => InjectionApi): void {
  Object.assign(globalThis, { [ORIGINAL_GLOBAL]: new OriginalProbe(scripting) });
}
