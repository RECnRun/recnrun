import { errorMessage } from "@recnrun/domain";
import type { Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { IncognitoControl } from "@/dashboard/IncognitoControl";
import { PeerProfiles } from "@/dashboard/PeerProfiles";
import { RecordingDetail } from "@/dashboard/RecordingDetail";
import { EmptyState, RecordingList } from "@/dashboard/RecordingList";
import { selectedRecordingId, titleFor } from "@/dashboard/route";
import type { DashboardRouter } from "@/dashboard/router";
import { PinHint } from "@/dashboard/PinHint";
import type { Navigation } from "@/dashboard/RouteLink";
import { TabList } from "@/dashboard/TabList";
import type { RemoteTake } from "@/dashboard/control";
import type { TakeControl } from "@/dashboard/TabList";
import type { ExtensionServices } from "@/views/extension-services";

type Load =
  | { status: "loading" }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "failed"; message: string };

export interface DashboardProps {
  services: ExtensionServices;
  router: DashboardRouter;
  take: TakeControl;
  /** Takes the control of a session in a paired profile, when there is one. */
  takeRemote?: RemoteTake;
}

function useSnapshot(loadSnapshot: () => Promise<Snapshot>): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    loadSnapshot().then(
      (snapshot) => setLoad({ status: "ready", snapshot }),
      (error: unknown) => setLoad({ status: "failed", message: errorMessage(error) }),
    );
  }, [loadSnapshot]);
  return load;
}

function Content(props: { load: Load; route: string; nav: Navigation }) {
  const { load, route, nav } = props;
  switch (load.status) {
    case "loading":
      return <p role="status">Loading your recordings…</p>;
    case "failed":
      return (
        <EmptyState title="Could not read your data">
          <p>{load.message}</p>
        </EmptyState>
      );
    case "ready": {
      const id = selectedRecordingId(route);
      if (id !== undefined) return <RecordingDetail snapshot={load.snapshot} id={id} nav={nav} />;
      return <RecordingList snapshot={load.snapshot} nav={nav} />;
    }
  }
}

function Profiles({ services, take, takeRemote }: Omit<DashboardProps, "router">) {
  if (!services.peers || !takeRemote) {
    return <TabList tabs={services.tabs} store={services.recordings} take={take} />;
  }
  return (
    <PeerProfiles services={services} peers={services.peers} take={take} takeRemote={takeRemote} />
  );
}

export function Dashboard({ services, router, take, takeRemote }: DashboardProps) {
  const load = useSnapshot(services.loadSnapshot);
  const [route, setRoute] = useState(router.initialRoute);
  useEffect(() => router.subscribe(setRoute), [router]);
  const navigate = (path: string) => {
    router.navigate(path);
    setRoute(path);
  };
  useEffect(() => {
    const snapshot = load.status === "ready" ? load.snapshot : undefined;
    router.publish(route, titleFor(snapshot, route));
  }, [router, route, load]);

  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
      </header>
      <main>
        <PinHint pin={services.toolbar} />
        <div class="session-panel">
          <IncognitoControl access={services.incognito}>
            <Profiles services={services} take={take} takeRemote={takeRemote} />
          </IncognitoControl>
        </div>
        <Content load={load} route={route} nav={{ router, navigate }} />
      </main>
    </>
  );
}
