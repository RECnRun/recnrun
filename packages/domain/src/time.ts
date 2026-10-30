import * as v from "valibot";

export const TimestampSchema = v.pipe(v.string(), v.isoTimestamp());
