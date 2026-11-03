import * as v from "valibot";
import {
  clearLikeAPage,
  listStores,
  seedStorage,
  tryReservedNames,
} from "@/background/original/page";

/** The part of `chrome.scripting.executeScript` the probe uses, so tests pass a fake. */
export interface Injection {
  target: { tabId: number };
  world: "ISOLATED" | "MAIN";
  func: (...args: string[]) => unknown;
  args: string[];
}

export interface InjectionApi {
  executeScript(injection: Injection): Promise<{ result?: unknown }[]>;
}

// The harness calls the probe through Runtime.evaluate, so every argument is checked where it enters.
const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const ProbeSchema = v.variant("step", [
  v.object({ tabId: TabIdSchema, step: v.literal("list") }),
  v.object({ tabId: TabIdSchema, step: v.literal("refuse"), name: v.string() }),
  v.object({ tabId: TabIdSchema, step: v.literal("clear") }),
]);

const SeedSchema = v.object({ tabId: TabIdSchema, key: v.string(), value: v.string() });

/**
 * P1.7's browser evidence: the fixture app never enumerates, clears, or names `__rec:` stores, so
 * these functions do it as page code in the original session's page (POC PLAN.md P1.7).
 */
export class OriginalProbe {
  readonly #scripting: () => InjectionApi;

  constructor(scripting: () => InjectionApi) {
    this.#scripting = scripting;
  }

  /** Runs `list`, `refuse` (with `name`), or `clear` in the page's MAIN world; returns its result. */
  async probe(request: unknown): Promise<unknown> {
    const parsed = v.parse(ProbeSchema, request);
    if (parsed.step === "refuse") {
      return this.#run(parsed.tabId, "MAIN", tryReservedNames, [parsed.name]);
    }
    return this.#run(
      parsed.tabId,
      "MAIN",
      parsed.step === "list" ? listStores : clearLikeAPage,
      [],
    );
  }

  /** Sets one localStorage item the way the isolator would, outside every page patch. */
  async seed(request: unknown): Promise<unknown> {
    const { tabId, key, value } = v.parse(SeedSchema, request);
    return this.#run(tabId, "ISOLATED", seedStorage, [key, value]);
  }

  async #run(
    tabId: number,
    world: Injection["world"],
    func: Injection["func"],
    args: string[],
  ): Promise<unknown> {
    const [frame] = await this.#scripting().executeScript({ target: { tabId }, world, func, args });
    if (!frame || !("result" in frame)) throw new Error(`no result from tab ${tabId}`);
    return frame.result;
  }
}
