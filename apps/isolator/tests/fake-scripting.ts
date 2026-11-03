import type { ContentScript, ScriptingApi } from "@/background/route-c/types";

/** A chrome.scripting stand-in that keeps registrations and rejects what Chrome rejects. */
export function fakeScripting() {
  const registered = new Map<string, ContentScript>();
  const calls: string[] = [];
  const api: ScriptingApi = {
    async registerContentScripts(scripts) {
      calls.push("register");
      for (const script of scripts) {
        if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
        registered.set(script.id, script);
      }
    },
    async updateContentScripts(scripts) {
      calls.push("update");
      for (const script of scripts) {
        const current = registered.get(script.id);
        if (!current) throw new Error(`No script with ID '${script.id}' to update.`);
        registered.set(script.id, { ...current, ...script });
      }
    },
    async unregisterContentScripts(filter) {
      calls.push("unregister");
      for (const id of filter?.ids ?? [...registered.keys()]) registered.delete(id);
    },
    async getRegisteredContentScripts(filter) {
      const all = [...registered.values()];
      return filter?.ids ? all.filter((script) => filter.ids?.includes(script.id)) : all;
    },
  };
  return { api, registered, calls };
}
