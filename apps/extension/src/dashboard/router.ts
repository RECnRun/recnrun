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
