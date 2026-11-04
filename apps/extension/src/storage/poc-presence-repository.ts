import * as v from "valibot";
import { storage } from "wxt/utils/storage";

const BootSchema = v.pipe(v.string(), v.uuid());

/**
 * What the POC builds' Downloads presence keeps (POC PLAN.md P2.2). Items are made on call, so a
 * build that never announces itself defines none.
 */
export function pocPresenceStore() {
  // Local, so an experiment sets it before the worker's first presence.
  const namespace = storage.defineItem<unknown>("local:pocNamespace");
  // Session storage ends with the browser, as a boot does; a worker restart keeps both.
  const boot = storage.defineItem<unknown>("session:pocBoot");
  const root = storage.defineItem<unknown>("session:pocDownloadsRoot");
  return {
    namespace: () => namespace.getValue(),
    boot: async () => {
      const stored = await boot.getValue();
      if (v.is(BootSchema, stored)) return stored;
      const created = crypto.randomUUID();
      await boot.setValue(created);
      return created;
    },
    root: {
      read: async () => {
        const stored = await root.getValue();
        return typeof stored === "string" ? stored : null;
      },
      write: (value: string) => root.setValue(value),
    },
  };
}
