import * as v from "valibot";
import { IdSchema } from "./ids.ts";
import { TargetUrlSchema } from "./managed-window.ts";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * One saved session of the target app, kept after Incognito closes: its label, where it opens,
 * and its last published capture's id, time, and approximate size.
 */
export const IdentitySchema = v.object({
  id: IdSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  url: TargetUrlSchema,
  created: CountSchema,
  lastCapture: v.optional(v.object({ id: IdSchema, at: CountSchema, bytes: CountSchema })),
});

export type Identity = v.InferOutput<typeof IdentitySchema>;

/** Every identity, each id once. */
export const IdentityListSchema = v.pipe(
  v.array(IdentitySchema),
  v.check((list) => new Set(list.map(({ id }) => id)).size === list.length, "Repeated identity."),
);

const sum = (values: Iterable<unknown>): number => {
  let total = 0;
  for (const value of values) total += approximateBytes(value);
  return total;
};

function containerBytes(value: object): number {
  if (value instanceof Map) return sum([...value.keys(), ...value.values()]);
  if (value instanceof Set || Array.isArray(value)) return sum(value as Iterable<unknown>);
  return sum(Object.entries(value).flat());
}

// The domain has no DOM types; a Blob, or a File, is told by its tag.
const isBlob = (value: object): value is { size: number } =>
  /^\[object (Blob|File)\]$/.test(Object.prototype.toString.call(value));

function objectBytes(value: object): number {
  if (isBlob(value)) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Date) return 8;
  return containerBytes(value);
}

/** A value's size as the dashboard shows it: strings in UTF-16, binary data by its length. */
export function approximateBytes(value: unknown): number {
  switch (typeof value) {
    case "string":
      return value.length * 2;
    case "number":
    case "bigint":
      return 8;
    case "boolean":
      return 4;
    case "object":
      return value === null ? 0 : objectBytes(value);
    case "undefined":
    case "symbol":
    case "function":
      return 0;
  }
}
