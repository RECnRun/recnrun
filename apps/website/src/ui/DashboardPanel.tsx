interface DashboardPanelProps {
  onOpen: () => void;
  /** The extension did not answer, so the toolbar icon is the way to the dashboard. */
  failed: boolean;
}

export function DashboardPanel({ onOpen, failed }: DashboardPanelProps) {
  return (
    <section class="banner" aria-labelledby="dashboard-panel-title">
      <h2 id="dashboard-panel-title">Your dashboard</h2>
      <p>Your recordings live in RECnRun&apos;s own tab, which opens with your browser.</p>
      <button type="button" class="button" onClick={onOpen}>
        Open dashboard
      </button>
      {failed && (
        <p role="alert">
          RECnRun did not open its dashboard. Click its icon in the toolbar to open it.
        </p>
      )}
    </section>
  );
}
