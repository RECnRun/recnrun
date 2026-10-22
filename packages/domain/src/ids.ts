import * as v from "valibot";

export const IdSchema = v.pipe(v.string(), v.nonEmpty());

export const NameSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
