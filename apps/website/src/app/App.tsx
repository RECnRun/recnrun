import { useExtensionState } from "@/features/extension-status/extension-state";
import type { ExtensionState } from "@/features/extension-status/extension-state";
import type { ExtensionGateway } from "@/services/extension";
import { InstallBanner } from "@/ui/InstallBanner";

function Content({ state }: { state: ExtensionState }) {
  switch (state.status) {
    case "detecting":
      return <p role="status">Looking for the RECnRun extension…</p>;
    case "missing":
      return <InstallBanner />;
    case "installed":
      // The extension covers this page with its dashboard; this shows only until it does.
      return <p role="status">Opening your RECnRun dashboard…</p>;
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
        <Content state={state} />
      </main>
      <footer class="site-footer">
        <a href="/privacy/">Privacy policy</a>
      </footer>
    </>
  );
}
