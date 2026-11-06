import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import { TokenSchema } from "@/p2p/downloads-rendezvous";
import { OperationSchema } from "@/onboarding/state";
import type { Operation } from "@/onboarding/state";

const MAX_WRITTEN = 16;
const WrittenSchema = v.pipe(v.array(TokenSchema), v.maxLength(MAX_WRITTEN));

/**
 * What "Prepare workers" keeps (POC P6.1): the last operation the page asked for, and the ids the
 * background wrote so it never writes one twice. Items are made on call, so production defines none.
 */
export function pocOnboardingStore() {
  const operation = storage.defineItem<unknown>("local:pocOnboarding");
  const written = storage.defineItem<unknown>("local:pocPrepareWritten");
  return {
    operation: {
      read: async (): Promise<Operation | undefined> => {
        const stored = v.safeParse(OperationSchema, await operation.getValue());
        return stored.success ? stored.output : undefined;
      },
      write: (value: Operation) => operation.setValue(value),
    },
    written: {
      has: async (id: string) => {
        const stored = v.safeParse(WrittenSchema, await written.getValue());
        return stored.success && stored.output.includes(id);
      },
      add: async (id: string) => {
        const stored = v.safeParse(WrittenSchema, await written.getValue());
        const known = stored.success ? stored.output : [];
        await written.setValue([...known, id].slice(-MAX_WRITTEN));
      },
    },
  };
}
