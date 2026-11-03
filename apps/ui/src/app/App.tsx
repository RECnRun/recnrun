import { useEffect, useState } from "preact/hooks";
import type { Api } from "@/api/api";
import { ApiProvider } from "@/api/context";
import { type Route, hrefOf, parseHash } from "@/app/routes";
import { Catalog } from "@/features/catalog/Catalog";
import { Editor } from "@/features/editor/Editor";
import { Recorder } from "@/features/recorder/Recorder";
import { Run } from "@/features/run/Run";
import { Setup } from "@/features/setup/Setup";

const NAV: { label: string; route: Route }[] = [
  { label: "Flows", route: { screen: "catalog" } },
  { label: "Record", route: { screen: "recorder" } },
  { label: "Setup", route: { screen: "setup" } },
];

function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (next: Route) => {
    location.hash = hrefOf(next);
    setRoute(next);
  };
  return [route, navigate];
}

function Screen({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  switch (route.screen) {
    case "setup":
      return <Setup />;
    case "catalog":
      return (
        <Catalog
          onOpen={(flowId) => navigate({ screen: "editor", flowId })}
          onRecord={() => navigate({ screen: "recorder" })}
        />
      );
    case "recorder":
      return <Recorder onFinalized={(flowId) => navigate({ screen: "editor", flowId })} />;
    case "editor":
      return (
        <Editor
          flowId={route.flowId}
          onRun={() => navigate({ screen: "run", flowId: route.flowId })}
        />
      );
    case "run":
      return <Run flowId={route.flowId} />;
  }
}

export function Header({ current }: { current?: Route["screen"] }) {
  return (
    <header class="app-header">
      <h1>RECnRun</h1>
      <nav aria-label="Main">
        {NAV.map(({ label, route }) => (
          <a
            key={label}
            href={hrefOf(route)}
            aria-current={route.screen === current ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}

/** The whole UI: navigation and the screen the hash names, all talking to `api`. */
export function App({ api }: { api: Api }) {
  const [route, navigate] = useRoute();
  return (
    <ApiProvider api={api}>
      <Header current={route.screen} />
      <main>
        <Screen route={route} navigate={navigate} />
      </main>
    </ApiProvider>
  );
}
