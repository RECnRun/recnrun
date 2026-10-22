import { useExtensionState } from "@/features/extension-status/extension-state";
import type { ExtensionState } from "@/features/extension-status/extension-state";
import { Explorer } from "@/features/explorer/Explorer";
import type { ExtensionGateway } from "@/services/extension";
import { EmptyState } from "@/ui/EmptyState";
import { InstallBanner } from "@/ui/InstallBanner";

function Content({ state }: { state: ExtensionState }) {
  switch (state.status) {
    case "detecting":
      return <p role="status">Looking for the RECnRun extension…</p>;
    case "missing":
      return <InstallBanner />;
    case "failed":
      return <EmptyState title="Could not read your data" message={state.message} />;
    case "ready":
      return <Explorer snapshot={state.snapshot} />;
  }
}

export function App({ gateway }: { gateway: ExtensionGateway }) {
  const state = useExtensionState(gateway);
  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
        {state.status === "ready" && (
          <p class="muted" data-testid="extension-version">
            Extension {state.extensionVersion}
          </p>
        )}
      </header>
      <main>
        <Content state={state} />
      </main>
    </>
  );
}
