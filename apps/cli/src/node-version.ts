/** The `engines.node` range of this package; a unit test keeps it equal to package.json. */
export const REQUIRED_NODE = ">=22.18.0";

const parts = (version: string): number[] =>
  version
    .replace(/^[^\d]*/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** Whether `version` satisfies a `>=x.y.z` range, the only form `engines.node` uses. */
export function satisfiesNode(version: string, range: string): boolean {
  const wanted = parts(range);
  const actual = parts(version);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (wanted[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
