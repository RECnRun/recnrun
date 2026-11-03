import { messageOf, PROTOCOL_VERSION, withTimeout } from "@/background/probes/helpers";
import { command } from "@/background/route-a/attached";
import { CURRENT_FILE, REDIRECTED_PATH } from "@/background/route-b/select";
import { SelectRequest } from "@/background/selection/requests";
import type {
  Selected,
  Selection,
  SelectionApis,
  SelectionOptions,
  SelectionStatus,
  SessionRule,
  SuspendRecord,
} from "@/background/selection/types";
import { parse } from "@/background/stop/requests";
import { requireLoopbackOrigin } from "@/background/stop/targets";
import { slotFile, slotMarker } from "@/content/route-c/names";

// Apart from E4's block rules, which count up from 1.
const FIRST_RULE = 6100;
const LAST_RULE = 6199;
const SUSPEND_KEY = "e6Suspend";
// Long enough for the harness's evaluation to return before the worker stops.
const SUSPEND_DELAY_MS = 250;

const isOwn = (rule: SessionRule) => rule.id >= FIRST_RULE && rule.id <= LAST_RULE;

/** E6 (POC PLAN.md P1.5): session rules select the slot a worker loads when it starts. */
export class SelectionEngine implements Selection {
  readonly #apis: () => SelectionApis;
  readonly #now: () => number;
  readonly #timeOrigin: number;
  readonly #schedule: (task: () => Promise<void>) => void;
  readonly #wakes: { event: string; at: number }[] = [];

  constructor(apis: () => SelectionApis, options: SelectionOptions = {}) {
    this.#apis = apis;
    this.#now = options.now ?? (() => performance.now());
    this.#timeOrigin = options.timeOrigin ?? performance.timeOrigin;
    this.#schedule =
      options.schedule ?? ((task) => void setTimeout(() => void task(), SUSPEND_DELAY_MS));
  }

  async select(request: unknown): Promise<Selected> {
    const { slot, origins } = parse(SelectRequest, request);
    origins.forEach(requireLoopbackOrigin);
    const apis = this.#apis();
    const file = slotFile(slotMarker(slot));
    const action = { type: "redirect" as const, redirect: { extensionPath: `/${file}` } };
    const urls = [
      `${apis.extensionOrigin}${CURRENT_FILE}`,
      ...origins.map((origin) => `${origin}${REDIRECTED_PATH}`),
    ];
    const addRules = urls.map((url, index) => ({
      id: FIRST_RULE + index,
      priority: 1,
      action,
      condition: { urlFilter: `|${url}` },
    }));
    const removed = (await this.rules()).map((rule) => rule.id);
    const startedAt = this.#now();
    await apis.dnr.updateSessionRules({ removeRuleIds: removed, addRules });
    const updateMs = this.#now() - startedAt;
    return { slot, file, ruleIds: addRules.map((rule) => rule.id), removed, updateMs };
  }

  async clear(): Promise<{ removed: number[] }> {
    const removed = (await this.rules()).map((rule) => rule.id);
    if (removed.length > 0) await this.#apis().dnr.updateSessionRules({ removeRuleIds: removed });
    return { removed };
  }

  async rules(): Promise<SessionRule[]> {
    return (await this.#apis().dnr.getSessionRules()).filter(isOwn);
  }

  async suspend(): Promise<{ targetId: string; timeOrigin: number }> {
    const apis = this.#apis();
    const targets = await apis.debugger.getTargets();
    const own = targets.find((t) => t.type === "worker" && t.url.startsWith(apis.extensionOrigin));
    if (!own) throw new Error(`no worker target at ${apis.extensionOrigin}`);
    const record: SuspendRecord = {
      targetId: own.id,
      timeOrigin: this.#timeOrigin,
      requestedAt: this.#now(),
    };
    await apis.storage.set({ [SUSPEND_KEY]: record });
    this.#schedule(() => closeSelf(apis, record));
    return { targetId: own.id, timeOrigin: this.#timeOrigin };
  }

  async status(): Promise<SelectionStatus> {
    const stored = await this.#apis().storage.get(SUSPEND_KEY);
    const suspend = (stored[SUSPEND_KEY] as SuspendRecord | undefined) ?? null;
    const ruleIds = (await this.rules()).map((rule) => rule.id);
    return { timeOrigin: this.#timeOrigin, wakes: [...this.#wakes], suspend, ruleIds };
  }

  /** Notes the event that started or woke this background. */
  woke(event: string): void {
    this.#wakes.push({ event, at: this.#now() });
  }
}

/** Attaches to this background's own target and closes it; storage keeps what happened. */
async function closeSelf(apis: SelectionApis, record: SuspendRecord): Promise<void> {
  const target = { targetId: record.targetId };
  const store = (outcome: Partial<SuspendRecord>) =>
    apis.storage.set({ [SUSPEND_KEY]: { ...record, ...outcome } });
  // Chrome keeps the extension attached after a previous suspension, since the worker's target outlives its stop.
  await apis.debugger.detach(target).catch(() => undefined);
  try {
    await withTimeout(apis.debugger.attach(target, PROTOCOL_VERSION), "attach");
  } catch (error) {
    await store({ attach: messageOf(error) });
    return;
  }
  await store({ attach: "ok" });
  try {
    await command(apis.debugger, target, "Target.closeTarget", { targetId: record.targetId });
  } catch (error) {
    await store({ attach: "ok", close: messageOf(error) });
  }
}
