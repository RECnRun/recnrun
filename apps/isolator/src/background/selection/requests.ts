import * as v from "valibot";
import { SLOT_COUNT } from "@/content/route-c/names";
import { OriginRequest } from "@/background/stop/requests";

// The harness calls the selection through Runtime.evaluate, so every argument is checked where it enters.
export const SelectRequest = v.strictObject({
  /** One of the prebuilt slot files `ns/slot-<slot>.js`. */
  slot: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SLOT_COUNT - 1)),
  /** The origins whose `/recnrun/current.js` a rule points at the slot. */
  origins: v.array(OriginRequest.entries.origin),
});
