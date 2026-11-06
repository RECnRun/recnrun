/** A folder of the run and the label a host verdict names it by. */
export type PathLabel = readonly [path: string, label: string];

const HOST_PATH = /\/(?:Users|home)\/[^\s"',;)]*/;

/** The first user-home path in `text`, or undefined. */
export function hostPathIn(text: string): string | undefined {
  return HOST_PATH.exec(text)?.[0];
}

/** Replaces every labelled path, longest first, in each string of `value`. */
export function labelPaths<T>(value: T, labels: readonly PathLabel[]): T {
  const ordered = [...labels].sort((a, b) => b[0].length - a[0].length);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      return ordered.reduce((text, [path, label]) => text.replaceAll(path, label), item);
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    }
    return item;
  };
  return walk(value) as T;
}
