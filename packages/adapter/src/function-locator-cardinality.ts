import type { CARDINALITIES } from "@recnrun/protocol";

export type Cardinality = (typeof CARDINALITIES)[number];

export interface Picked<T> {
  status: "matched" | "not-found" | "ambiguous";
  selected: T[];
}

const matched = <T>(selected: T[]): Picked<T> => ({ status: "matched", selected });
const notFound = <T>(): Picked<T> => ({ status: "not-found", selected: [] });
const ambiguous = <T>(): Picked<T> => ({ status: "ambiguous", selected: [] });

/**
 * Applies a cardinality to the elements a locator found: `one` needs exactly one, `optional` zero
 * or one, `many` at least one, and `nth` the element at `index`.
 */
export function applyCardinality<T>(items: T[], cardinality: Cardinality, index = 0): Picked<T> {
  if (cardinality === "nth") {
    const item = items[index];
    return item === undefined ? notFound() : matched([item]);
  }
  if (items.length === 0) return cardinality === "optional" ? matched([]) : notFound();
  if (items.length > 1 && cardinality !== "many") return ambiguous();
  return matched(items);
}
