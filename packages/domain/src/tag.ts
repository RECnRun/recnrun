import * as v from "valibot";

/** `tag`, `tag:subtag`, `tag:subtag:subsubtag`, …; case is kept as typed. */
export const TagSchema = v.pipe(
  v.string(),
  v.regex(/^[\w-]+(?::[\w-]+)*$/, "A tag is segments of letters, digits, _ or -, joined by :"),
);

export const TagsSchema = v.pipe(
  v.array(TagSchema),
  v.check((tags) => new Set(tags).size === tags.length, "Tags must be unique."),
);

export type Tag = v.InferOutput<typeof TagSchema>;
