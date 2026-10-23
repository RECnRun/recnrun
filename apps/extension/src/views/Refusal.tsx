/** What an extension page shows instead of itself under a page that may not frame it. */
export function Refusal({ origin }: { origin: string }) {
  return (
    <main>
      <p role="alert">RECnRun does not run inside {origin}.</p>
    </main>
  );
}
