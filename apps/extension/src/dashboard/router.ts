import * as v from "valibot";
import { subscribeFrame } from "@/messaging/frame-channel";
import { locationMessage, navigateMessage, PathSchema } from "@/messaging/frame-protocol";

/** Where the dashboard keeps its route, so links, reloads, and Back work. */
export interface DashboardRouter {
  initialRoute: string;
  href(path: string): string;
  subscribe(listener: (path: string) => void): () => void;
  /** Adds a route the user opened in the dashboard to the history. */
  navigate(path: string): void;
  /** Titles the route the dashboard shows. */
  publish(path: string, title: string): void;
}

function frameRoute(search: string): string {
  const parsed = v.safeParse(PathSchema, new URLSearchParams(search).get("route"));
  return parsed.success ? parsed.output : "/";
}

/** Routes in the embedding site's address bar, which the content script keeps in sync. */
export function createFrameRouter(parentOrigin: string, page: Window = window): DashboardRouter {
  return {
    initialRoute: frameRoute(page.location.search),
    href: (path) => parentOrigin + path,
    subscribe: (listener) =>
      subscribeFrame(page, page.parent, parentOrigin, { route: ({ path }) => listener(path) }),
    navigate(path) {
      page.parent.postMessage(navigateMessage(path), parentOrigin);
    },
    publish(path, title) {
      page.parent.postMessage(locationMessage(path, title), parentOrigin);
    },
  };
}
