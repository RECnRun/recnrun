/** The text a view or a reply shows for a caught value, which may be anything a promise rejects with. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
