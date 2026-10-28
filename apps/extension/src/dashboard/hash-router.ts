import * as v from "valibot";
import type { DashboardRouter } from "@/dashboard/router";
import { PathSchema } from "@/dashboard/route";

/** The route the address's hash names; anything but a path is the list. */
function hashRoute(hash: string): string {
  const parsed = v.safeParse(PathSchema, hash.slice(1));
  return parsed.success ? parsed.output : "/";
}

/** Routes in the dashboard tab's hash: the extension serves files by path, so reloads keep only the hash. */
export function createHashRouter(page: Window = window): DashboardRouter {
  const initialRoute = hashRoute(page.location.hash);
  return {
    initialRoute,
    href: (path) => `#${path}`,
    subscribe(listener) {
      const onChange = () => listener(hashRoute(page.location.hash));
      page.addEventListener("hashchange", onChange);
      // The dashboard subscribes after its first render; a hash that moved before then would go unheard.
      if (hashRoute(page.location.hash) !== initialRoute) onChange();
      return () => page.removeEventListener("hashchange", onChange);
    },
    navigate(path) {
      // Unlike assigning the hash, this fires no hashchange, so the dashboard hears its own move once.
      page.history.pushState(null, "", `#${path}`);
    },
    publish(_path, title) {
      page.document.title = title;
    },
  };
}
