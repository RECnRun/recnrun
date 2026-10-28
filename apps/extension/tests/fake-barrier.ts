import type { AgentScript, BarrierApi, BarrierRule } from "@/background/workspace/barrier";

/** An in-memory DNR session ruleset and content-script registry; fakeBrowser implements neither. */
export interface FakeBarrierApi extends BarrierApi {
  rules: Map<number, BarrierRule>;
  scripts: Map<string, AgentScript>;
  /** When set, removals are acknowledged but nothing is removed, as a Chrome that fails to. */
  ignoreRemovals: boolean;
  /** When set, registering a script rejects with this error. */
  registerError: Error | undefined;
}

export function fakeBarrierApi(): FakeBarrierApi {
  const api: FakeBarrierApi = {
    rules: new Map(),
    scripts: new Map(),
    ignoreRemovals: false,
    registerError: undefined,
    addSessionRules: async (rules) => {
      // Chrome rejects the whole update when one id already exists.
      if (rules.some(({ id }) => api.rules.has(id))) throw new Error("Rule id already in use.");
      for (const rule of rules) api.rules.set(rule.id, rule);
    },
    removeSessionRules: async (ids) => {
      if (!api.ignoreRemovals) for (const id of ids) api.rules.delete(id);
    },
    sessionRuleIds: async () => [...api.rules.keys()],
    registerScript: async (script) => {
      if (api.registerError) throw api.registerError;
      if (api.scripts.has(script.id)) throw new Error("Duplicate script id.");
      api.scripts.set(script.id, script);
    },
    unregisterScript: async (id) => {
      if (!api.scripts.has(id)) throw new Error("Nonexistent script id.");
      if (!api.ignoreRemovals) api.scripts.delete(id);
    },
    registeredScriptIds: async () => [...api.scripts.keys()],
  };
  return api;
}
