import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import { SettingSchema } from "@/p2p/poc-setting";

/**
 * What a template base keeps in `chrome.storage.local` (POC PLAN.md P5.1): the bootstrap page
 * of `#template=` sets both, and P5.3's service worker reads `templateMode` before it announces.
 * Items are made on call, so a build that never enters template mode defines none.
 */
export function pocTemplateStore() {
  const mode = storage.defineItem<unknown>("local:templateMode");
  const setting = storage.defineItem<unknown>("local:pocSetting");
  return {
    /** True only for a stored `true`; anything else, unset included, is not template mode. */
    templateMode: async () => v.is(v.literal(true), await mode.getValue()),
    setting: async () => {
      const stored = v.safeParse(SettingSchema, await setting.getValue());
      return stored.success ? stored.output : null;
    },
    enter: async (name: string) => {
      const parsed = v.parse(SettingSchema, name);
      await setting.setValue(parsed);
      await mode.setValue(true);
    },
  };
}
