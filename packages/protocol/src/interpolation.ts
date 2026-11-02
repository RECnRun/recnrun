import * as v from "valibot";

/** The only namespaces a `${...}` reference may read; anything else is rejected, never evaluated. */
export const INTERPOLATION_NAMESPACES = ["env", "inputs", "vars", "locals", "secrets"] as const;

export type InterpolationNamespace = (typeof INTERPOLATION_NAMESPACES)[number];

/** One `${namespace.path}` occurrence; `namespace` is kept as written so callers can report it. */
export type InterpolationReference = {
  raw: string;
  namespace: string;
  path: string[];
  start: number;
};

const REFERENCE = /\$\{([^}]*)\}/g;
const SEGMENT = /^[A-Za-z_]\w*$/;

/** Returns every `${...}` reference in `text`, in order, without judging its namespace. */
export function parseInterpolations(text: string): InterpolationReference[] {
  return [...text.matchAll(REFERENCE)].map((match) => {
    const [namespace = "", ...path] = (match[1] ?? "").split(".");
    return { raw: match[0], namespace, path, start: match.index };
  });
}

function isKnownNamespace(namespace: string): boolean {
  return (INTERPOLATION_NAMESPACES as readonly string[]).includes(namespace);
}

/** True when every reference reads a documented namespace. */
export function hasKnownNamespaces(text: string): boolean {
  return parseInterpolations(text).every((reference) => isKnownNamespace(reference.namespace));
}

/** True when every reference of a documented namespace names a dotted path of identifiers. */
export function hasWellFormedReferences(text: string): boolean {
  return parseInterpolations(text).every(
    (reference) =>
      !isKnownNamespace(reference.namespace) ||
      (reference.path.length > 0 && reference.path.every((segment) => SEGMENT.test(segment))),
  );
}

/** A string that may interpolate `${env|inputs|vars|locals|secrets.<path>}` and nothing else. */
export const StringWithInterpolationSchema = v.pipe(
  v.string(),
  v.check(hasKnownNamespaces, "Interpolation reads an unknown namespace."),
  v.check(hasWellFormedReferences, "Interpolation must be ${namespace.name}."),
);
