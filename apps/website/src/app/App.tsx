import { useRoute, workflowHref } from "@/app/route";
import type { Route } from "@/app/route";
import { useExtensionState } from "@/features/extension-status/extension-state";
import { RecordingStatus } from "@/features/recording-status/RecordingStatus";
import { Timeline } from "@/features/timeline/Timeline";
import { WorkflowList } from "@/features/workflows/WorkflowList";
import type { ExtensionGateway } from "@/services/extension";
import { InstallBanner } from "@/ui/InstallBanner";

function Page({ route, gateway }: { route: Route; gateway: ExtensionGateway }) {
  switch (route.name) {
    case "workflows":
      return <WorkflowList gateway={gateway} hrefFor={workflowHref} />;
    case "workflow":
      return <Timeline gateway={gateway} id={route.id} backHref="#/" />;
  }
}

export function App({ gateway }: { gateway: ExtensionGateway }) {
  const state = useExtensionState(gateway);
  const route = useRoute();
  return (
    <>
      <header class="site-header">
        <h1>
          <a href="#/">RECnRun</a>
        </h1>
        {state.status === "ready" && (
          <p class="muted" data-testid="extension-version">
            Extension {state.extensionVersion}
          </p>
        )}
      </header>
      <main>
        {state.status === "detecting" && <p role="status">Looking for the RECnRun extension…</p>}
        {state.status === "missing" && <InstallBanner />}
        {state.status === "ready" && (
          <>
            <RecordingStatus gateway={gateway} />
            <Page route={route} gateway={gateway} />
          </>
        )}
      </main>
    </>
  );
}
