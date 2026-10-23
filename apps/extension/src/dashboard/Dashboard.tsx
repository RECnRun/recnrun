import type { Snapshot } from "@recnrun/domain";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { RecordingCard } from "@/dashboard/RecordingCard";
import { toRecordingViews } from "@/dashboard/recording-view";
import { recordingPath, selectedRecordingId, titleFor } from "@/dashboard/route";
import type { DashboardRouter } from "@/dashboard/router";

type Load =
  | { status: "loading" }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "failed"; message: string };

interface Navigation {
  router: DashboardRouter;
  navigate: (path: string) => void;
}

export interface DashboardProps {
  loadSnapshot: () => Promise<Snapshot>;
  router: DashboardRouter;
}

function useSnapshot(loadSnapshot: () => Promise<Snapshot>): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    loadSnapshot().then(
      (snapshot) => setLoad({ status: "ready", snapshot }),
      (error: unknown) =>
        setLoad({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [loadSnapshot]);
  return load;
}

function RouteLink(props: { path: string; nav: Navigation; children: ComponentChildren }) {
  const { path, nav, children } = props;
  return (
    <a
      href={nav.router.href(path)}
      onClick={(event) => {
        // Modified clicks keep the browser's behavior, such as opening the link in a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        nav.navigate(path);
      }}
    >
      {children}
    </a>
  );
}

function EmptyState({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="empty-state" role="status">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function RecordingList({ snapshot, nav }: { snapshot: Snapshot; nav: Navigation }) {
  if (snapshot.recordings.length === 0) {
    return (
      <EmptyState title="No recordings yet">
        <p>Open the page you want to capture and start a recording from the extension.</p>
      </EmptyState>
    );
  }
  return (
    <div class="recordings">
      {toRecordingViews(snapshot.recordings).map((recording) => (
        <RecordingCard
          key={recording.id}
          recording={recording}
          title={
            <RouteLink path={recordingPath(recording.id)} nav={nav}>
              {recording.name}
            </RouteLink>
          }
        />
      ))}
    </div>
  );
}

function RecordingDetail(props: { snapshot: Snapshot; id: string; nav: Navigation }) {
  const recording = toRecordingViews(props.snapshot.recordings).find(({ id }) => id === props.id);
  return (
    <>
      <p>
        <RouteLink path="/" nav={props.nav}>
          All recordings
        </RouteLink>
      </p>
      {recording ? (
        <RecordingCard recording={recording} title={recording.name} />
      ) : (
        <EmptyState title="Recording not found">
          <p>This extension has no recording with that link. It may have been deleted.</p>
        </EmptyState>
      )}
    </>
  );
}

function Content({ load, route, nav }: { load: Load; route: string; nav: Navigation }) {
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
      if (id === undefined) return <RecordingList snapshot={load.snapshot} nav={nav} />;
      return <RecordingDetail snapshot={load.snapshot} id={id} nav={nav} />;
    }
  }
}

export function Dashboard({ loadSnapshot, router }: DashboardProps) {
  const load = useSnapshot(loadSnapshot);
  const [route, setRoute] = useState(router.initialRoute);
  useEffect(() => router.subscribe(setRoute), [router]);
  useEffect(() => {
    router.publish(route, titleFor(load.status === "ready" ? load.snapshot : undefined, route));
  }, [router, route, load]);

  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
      </header>
      <main>
        <Content load={load} route={route} nav={{ router, navigate: setRoute }} />
      </main>
    </>
  );
}
