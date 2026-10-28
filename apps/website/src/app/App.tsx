import { useExtensionState } from "@/features/extension-status/extension-state";
import type { ExtensionState } from "@/features/extension-status/extension-state";
import { useOpenDashboard } from "@/features/open-dashboard/open-dashboard";
import type { ExtensionGateway } from "@/services/extension";
import { DashboardPanel } from "@/ui/DashboardPanel";
import { InstallBanner } from "@/ui/InstallBanner";

/** Mounted once the extension is found, so the dashboard comes forward once per page load. */
function Installed({ gateway }: { gateway: ExtensionGateway }) {
  const { open, failed } = useOpenDashboard(gateway);
  return <DashboardPanel onOpen={open} failed={failed} />;
}

function Content({ state, gateway }: { state: ExtensionState; gateway: ExtensionGateway }) {
  switch (state.status) {
    case "detecting":
      return <p role="status">Looking for the RECnRun extension…</p>;
    case "missing":
      return <InstallBanner />;
    case "installed":
      return <Installed gateway={gateway} />;
  }
}

export function App({ gateway }: { gateway: ExtensionGateway }) {
  const state = useExtensionState(gateway);
  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
        {state.status === "installed" && (
          <p class="muted" data-testid="extension-version">
            Extension {state.extensionVersion}
          </p>
        )}
      </header>
      <main>
        <Content state={state} gateway={gateway} />
      </main>
      <footer class="site-footer">
        <a href="/privacy/">Privacy policy</a>
      </footer>
    </>
  );
}
