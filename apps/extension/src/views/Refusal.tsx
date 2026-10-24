/** What an extension page shows instead of itself under a page that may not frame it. */
export function Refusal({ origin }: { origin: string }) {
  return (
    <main>
      <p role="alert">RECnRun does not run inside {origin}.</p>
    </main>
  );
}

/** What an extension page shows when opened on its own, outside the site that frames it. */
export function SiteOnly() {
  return (
    <main>
      <p role="status">Open recnrun.com to use RECnRun.</p>
    </main>
  );
}
