import type { ComponentChildren } from "preact";
import type { DashboardRouter } from "@/dashboard/router";

/** The dashboard's router and the navigation that also updates the route it shows. */
export interface Navigation {
  router: DashboardRouter;
  navigate: (path: string) => void;
}

export function RouteLink(props: { path: string; nav: Navigation; children: ComponentChildren }) {
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
