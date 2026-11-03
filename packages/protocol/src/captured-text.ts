import * as v from "valibot";

/** The capture clips every string it reports (values, keys, attributes) to this many characters. */
export const MAX_CAPTURED_TEXT = 1024;

/** A string the capture clipped to `MAX_CAPTURED_TEXT`. */
export const CapturedTextSchema = v.pipe(v.string(), v.maxLength(MAX_CAPTURED_TEXT));
