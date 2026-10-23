import type { Snapshot } from "@recnrun/domain";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { RecordControls } from "@/dashboard/panel/RecordControls";
import type { RecordSetup } from "@/dashboard/panel/RecordControls";
import { RecordingCard } from "@/dashboard/RecordingCard";
import { toRecordingViews } from "@/dashboard/recording-view";
import type { RecordingView } from "@/dashboard/recording-view";
import { recordingPath, selectedRecordingId, titleFor } from "@/dashboard/route";
import type { DashboardRouter } from "@/dashboard/router";
import { groupByWorkspace, workspaceName } from "@/dashboard/workspace";

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
  /** Shows only this workspace, as next to its site in a Split View. */
  workspace?: string;
  /** Where the recording panel opens; without it the dashboard offers no Record button. */
  record?: RecordSetup;
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

function EmptyState(props: { title: string; nested?: boolean; children: ComponentChildren }) {
  const Heading = props.nested ? "h3" : "h2";
  return (
    <div class="empty-state" role="status">
      <Heading>{props.title}</Heading>
      {props.children}
    </div>
  );
}

function WorkspaceSection(props: { workspace: string; children: ComponentChildren }) {
  const id = `workspace-${workspaceName(props.workspace)}`;
  return (
    <section class="workspace" aria-labelledby={id}>
      <h2 id={id}>{workspaceName(props.workspace)}</h2>
      {props.children}
    </section>
  );
}

function RecordingCards({ views, nav }: { views: RecordingView[]; nav: Navigation }) {
  return (
    <div class="recordings">
      {views.map((recording) => (
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

function WorkspaceList(props: { snapshot: Snapshot; workspace: string; nav: Navigation }) {
  const { snapshot, workspace, nav } = props;
  const views = toRecordingViews(snapshot.recordings).filter(
    (view) => view.workspace === workspace,
  );
  return (
    <WorkspaceSection workspace={workspace}>
      {views.length === 0 ? (
        <EmptyState title="No recordings yet" nested>
          <p>Start a recording on {workspaceName(workspace)} from the extension.</p>
        </EmptyState>
      ) : (
        <RecordingCards views={views} nav={nav} />
      )}
    </WorkspaceSection>
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
  return groupByWorkspace(toRecordingViews(snapshot.recordings)).map(
    ({ workspace, recordings }) => (
      <WorkspaceSection key={workspace} workspace={workspace}>
        <RecordingCards views={recordings} nav={nav} />
      </WorkspaceSection>
    ),
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
        <WorkspaceSection workspace={recording.workspace}>
          <RecordingCard recording={recording} title={recording.name} />
        </WorkspaceSection>
      ) : (
        <EmptyState title="Recording not found">
          <p>This extension has no recording with that link. It may have been deleted.</p>
        </EmptyState>
      )}
    </>
  );
}

function Content(props: { load: Load; route: string; workspace?: string; nav: Navigation }) {
  const { load, route, workspace, nav } = props;
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
      if (workspace === undefined) return <RecordingList snapshot={load.snapshot} nav={nav} />;
      return <WorkspaceList snapshot={load.snapshot} workspace={workspace} nav={nav} />;
    }
  }
}

export function Dashboard({ loadSnapshot, router, workspace, record }: DashboardProps) {
  const load = useSnapshot(loadSnapshot);
  const [route, setRoute] = useState(router.initialRoute);
  useEffect(() => router.subscribe(setRoute), [router]);
  useEffect(() => {
    const snapshot = load.status === "ready" ? load.snapshot : undefined;
    router.publish(route, titleFor(snapshot, route, workspace));
  }, [router, route, load, workspace]);

  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
        {record && <RecordControls {...record} />}
      </header>
      <main>
        <Content
          load={load}
          route={route}
          workspace={workspace}
          nav={{ router, navigate: setRoute }}
        />
      </main>
    </>
  );
}

export function Refusal({ origin }: { origin: string }) {
  return (
    <main>
      <p role="alert">RECnRun does not run inside {origin}.</p>
    </main>
  );
}
