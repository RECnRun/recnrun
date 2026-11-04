import * as v from "valibot";
import { storage } from "wxt/utils/storage";

const BootSchema = v.pipe(v.string(), v.uuid());

/** Profiles the catalog showed that no peer record knew: waiting for a renewal, or renewed for. */
const NewcomersSchema = v.object({
  waiting: v.array(v.string()),
  renewed: v.array(v.string()),
});
export type Newcomers = v.InferOutput<typeof NewcomersSchema>;

/**
 * What the POC builds' Downloads presence keeps (POC PLAN.md P2.2). Items are made on call, so a
 * build that never announces itself defines none.
 */
export function pocPresenceStore() {
  // Local, so an experiment sets it before the worker's first presence.
  const namespace = storage.defineItem<unknown>("local:pocNamespace");
  const policy = storage.defineItem<unknown>("local:pocPresencePolicy");
  // Session storage ends with the browser, as a boot does; a worker restart keeps both.
  const boot = storage.defineItem<unknown>("session:pocBoot");
  const root = storage.defineItem<unknown>("session:pocDownloadsRoot");
  const newcomers = storage.defineItem<unknown>("session:pocNewcomers");
  return {
    namespace: () => namespace.getValue(),
    policy: () => policy.getValue(),
    boot: async () => {
      const stored = await boot.getValue();
      if (v.is(BootSchema, stored)) return stored;
      const created = crypto.randomUUID();
      await boot.setValue(created);
      return created;
    },
    newcomers: {
      read: async (): Promise<Newcomers> => {
        const stored = v.safeParse(NewcomersSchema, await newcomers.getValue());
        return stored.success ? stored.output : { waiting: [], renewed: [] };
      },
      write: (value: Newcomers) => newcomers.setValue(value),
    },
    /** The launcher's bootstrap token becomes the boot, so it finds the presence that carries it. */
    adoptBoot: (token: string) => boot.setValue(token),
    root: {
      read: async () => {
        const stored = await root.getValue();
        return typeof stored === "string" ? stored : null;
      },
      write: (value: string) => root.setValue(value),
    },
  };
}
