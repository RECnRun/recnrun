/** The `index`th name of A, B, …, Z, AA, AB, …: bijective base 26. */
function nameAt(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/** The first of A, B, …, Z, AA, AB, … that no label in `taken` already is, ignoring case. */
export function nextIdentityName(taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toUpperCase()));
  let index = 0;
  while (used.has(nameAt(index))) index += 1;
  return nameAt(index);
}
