import type { IdentityCapture } from "@recnrun/domain";

type ValueType = IdentityCapture["valueTypes"][number];

type Constructor = abstract new (...args: never[]) => object;

// File before Blob and DataView before the typed arrays: the narrower type names the value.
const CLASSES: [Constructor, ValueType][] = [
  [Date, "Date"],
  [RegExp, "RegExp"],
  [Map, "Map"],
  [Set, "Set"],
  [ArrayBuffer, "ArrayBuffer"],
  [DataView, "DataView"],
  [File, "File"],
  [Blob, "Blob"],
  [Array, "Array"],
];

function typeOf(value: object): ValueType {
  const known = CLASSES.find(([type]) => value instanceof type);
  if (known) return known[1];
  return ArrayBuffer.isView(value) ? "TypedArray" : "Object";
}

function childrenOf(value: object, type: ValueType): unknown[] {
  if (value instanceof Map) return [...value.keys(), ...value.values()];
  if (value instanceof Set) return [...value];
  return type === "Array" || type === "Object" ? Object.values(value) : [];
}

/** Adds the structured-clone types that `values` hold, at any depth, to `found`. */
export function collectValueTypes(values: unknown[], found: Set<ValueType>): void {
  // A stack, not recursion: clones may nest deeply or refer to themselves.
  const pending = [...values];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) {
      found.add("primitive");
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    const type = typeOf(value);
    found.add(type);
    for (const child of childrenOf(value, type)) pending.push(child);
  }
}
