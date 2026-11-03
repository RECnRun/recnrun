import { parseInstall, parseSetMarker } from "@/background/route-c/requests";
import type { ContentScript, RouteC, ScriptingApi } from "@/background/route-c/types";
import {
  BOOTSTRAP_FILE,
  ORIGINAL_SLOT,
  SLOT_COUNT,
  slotFile,
  slotMarker,
  strategyFile,
} from "@/content/route-c/names";
import type { WorkerStrategy } from "@/content/route-c/names";

export const ROUTE_C_SCRIPT_ID = "recnrun-route-c";

const BY_ID = { ids: [ROUTE_C_SCRIPT_ID] };

/** The slot file first, so the bootstrap finds its marker; the strategy file, when any; then the bootstrap. */
function filesOf(slot: string, strategy: WorkerStrategy): string[] {
  const strategyScript = strategyFile(strategy);
  return [slotFile(slot), ...(strategyScript ? [strategyScript] : []), BOOTSTRAP_FILE];
}

/**
 * Route C (POC PLAN.md P1.6): a MAIN-world script at document_start installs the marker in every
 * matching frame. Chrome reads a registration's files when a frame starts, so a marker is a slot
 * file and switching it updates which slot the registration names.
 */
export class RouteCEngine implements RouteC {
  readonly #scripting: () => ScriptingApi;
  #next = 0;
  #strategy: WorkerStrategy | undefined;

  constructor(scripting: () => ScriptingApi) {
    this.#scripting = scripting;
  }

  async install(request: unknown): Promise<string> {
    const { matches, workers } = parseInstall(request);
    const api = this.#scripting();
    if ((await api.getRegisteredContentScripts(BY_ID)).length > 0) {
      await api.unregisterContentScripts(BY_ID);
    }
    const slot = this.#takeSlot();
    await api.registerContentScripts([
      {
        id: ROUTE_C_SCRIPT_ID,
        matches,
        js: filesOf(slot, workers),
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: false,
      },
    ]);
    this.#strategy = workers;
    return slot;
  }

  async setMarker(request: unknown): Promise<string> {
    parseSetMarker(request);
    const strategy = this.#requireStrategy();
    const slot = this.#takeSlot();
    await this.#scripting().updateContentScripts([
      { id: ROUTE_C_SCRIPT_ID, js: filesOf(slot, strategy) },
    ]);
    return slot;
  }

  async setOriginal(): Promise<string> {
    const strategy = this.#requireStrategy();
    await this.#scripting().updateContentScripts([
      { id: ROUTE_C_SCRIPT_ID, js: filesOf(ORIGINAL_SLOT, strategy) },
    ]);
    return ORIGINAL_SLOT;
  }

  async uninstall(): Promise<void> {
    this.#strategy = undefined;
    const api = this.#scripting();
    if ((await api.getRegisteredContentScripts(BY_ID)).length === 0) return;
    await api.unregisterContentScripts(BY_ID);
  }

  registered(): Promise<ContentScript[]> {
    return this.#scripting().getRegisteredContentScripts(BY_ID);
  }

  #requireStrategy(): WorkerStrategy {
    if (this.#strategy === undefined)
      throw new Error("Route C is not installed; call install() first");
    return this.#strategy;
  }

  // Round robin: consecutive markers never share a slot, so a stale injection shows in the ledger.
  #takeSlot(): string {
    const slot = slotMarker(this.#next % SLOT_COUNT);
    this.#next += 1;
    return slot;
  }
}
