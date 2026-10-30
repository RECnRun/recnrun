import { OriginSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import { ResponseUrlPairsSchema } from "@/messaging/response-url-protocol";
import type { ResponseUrlStore } from "@/ports/response-urls";

// Session storage: the restored caches live in the Incognito profile, which ends with the browser.
const responseUrlsItem = storage.defineItem<unknown>("session:response-urls");

const StoredSchema = v.object({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origins: v.record(OriginSchema, ResponseUrlPairsSchema),
});

export const responseUrlStore: ResponseUrlStore = {
  read: async (generation) => {
    const stored = await responseUrlsItem.getValue();
    if (stored === null) return {};
    const parsed = v.safeParse(StoredSchema, stored);
    if (!parsed.success) {
      throw new Error("The stored response URLs do not match the current schema.");
    }
    return parsed.output.generation === generation ? parsed.output.origins : {};
  },
  write: (generation, origins) => responseUrlsItem.setValue({ generation, origins }),
};
