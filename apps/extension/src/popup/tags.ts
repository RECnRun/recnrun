/** Tags typed in one field, separated by commas or whitespace. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((tag) => tag !== ""))];
}
