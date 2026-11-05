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
  const adopted = storage.defineItem<unknown>("session:pocBootAdopted");
  const newcomers = storage.defineItem<unknown>("session:pocNewcomers");
  return {
    namespace: () => namespace.getValue(),
    policy: () => policy.getValue(),
    /** The session's boot if one was made; unlike `boot`, it never makes one. */
    peekBoot: async () => {
      const stored = await boot.getValue();
      return v.is(BootSchema, stored) ? stored : null;
    },
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
    /**
     * The first bootstrap token of a session becomes its boot, so the launcher finds the presence
     * that carries it; a later attempt finds a running session, whose boot stays the one its
     * peers and presences already name, and answers through the ack.
     */
    adoptBoot: async (token: string) => {
      if ((await adopted.getValue()) === true) return;
      await boot.setValue(token);
      await adopted.setValue(true);
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
