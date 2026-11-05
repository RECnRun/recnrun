import * as v from "valibot";

/** The name the launcher gives a base (POC PLAN.md P5.1), such as `base-v1`. */
export const SettingSchema = v.pipe(v.string(), v.regex(/^base-v[0-9]+$/));
