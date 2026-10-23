import * as v from "valibot";
import { locationMessage, PathSchema, RouteMessageSchema } from "@/messaging/frame-protocol";

/** Where the dashboard keeps its route, so links, reloads, and Back work. */
export interface DashboardRouter {
  initialRoute: string;
  href(path: string): string;
  subscribe(listener: (path: string) => void): () => void;
  publish(path: string, title: string): void;
}

const hashRoute = (hash: string) => (hash.startsWith("#/") ? hash.slice(1) : "/");

/** Routes in the hash, because an extension page has no server to answer other paths. */
export function createHashRouter(page: Window = window): DashboardRouter {
  return {
    initialRoute: hashRoute(page.location.hash),
    href: (path) => `#${path}`,
    subscribe(listener) {
      const onChange = () => listener(hashRoute(page.location.hash));
      page.addEventListener("hashchange", onChange);
      return () => page.removeEventListener("hashchange", onChange);
    },
    publish(path, title) {
      if (hashRoute(page.location.hash) !== path) page.location.hash = path;
      page.document.title = title;
    },
  };
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
    subscribe(listener) {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== page.parent || event.origin !== parentOrigin) return;
        const parsed = v.safeParse(RouteMessageSchema, event.data);
        if (parsed.success) listener(parsed.output.path);
      };
      page.addEventListener("message", onMessage);
      return () => page.removeEventListener("message", onMessage);
    },
    publish(path, title) {
      page.parent.postMessage(locationMessage(path, title), parentOrigin);
    },
  };
}
