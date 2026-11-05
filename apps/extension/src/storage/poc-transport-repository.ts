import * as v from "valibot";
import { storage } from "wxt/utils/storage";

const LastErrorSchema = v.strictObject({
  at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  message: v.string(),
});
export type LastError = v.InferOutput<typeof LastErrorSchema>;

const PausedSchema = v.picklist(["disconnect", "forget"]);
export type Paused = v.InferOutput<typeof PausedSchema>;

/**
 * What the diagnostics page shows of the Downloads transport (POC PLAN.md P5.4): why this profile
 * told the launcher to leave it alone, and the last error its presence logged. Items are made on
 * call, so a build that never announces itself defines none.
 */
export function pocTransportStore() {
  const lastError = storage.defineItem<unknown>("local:pocTransportError");
  const paused = storage.defineItem<unknown>("local:pocPaused");
  return {
    lastError: async (): Promise<LastError | null> => {
      const stored = v.safeParse(LastErrorSchema, await lastError.getValue());
      return stored.success ? stored.output : null;
    },
    paused: async (): Promise<Paused | null> => {
      const stored = v.safeParse(PausedSchema, await paused.getValue());
      return stored.success ? stored.output : null;
    },
    /** The presence writer's last failure; a later success leaves it, so the page shows what went wrong. */
    recordError: (message: string) => lastError.setValue({ at: Date.now(), message }),
    /** A copy starts without the error its template recorded. */
    clearError: () => lastError.removeValue(),
    /** `resumed` clears the pause, as the launcher reads it. */
    setPaused: (reason: Paused | "resumed") =>
      paused.setValue(reason === "resumed" ? null : reason),
  };
}
