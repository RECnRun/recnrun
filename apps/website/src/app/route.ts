import { useEffect, useState } from "preact/hooks";

export type Route = { name: "workflows" } | { name: "workflow"; id: string };

/** `#/` lists workflows and `#/workflows/<id>` shows one timeline; anything else lists. */
export function parseRoute(hash: string): Route {
  const match = /^#\/workflows\/([^/]+)$/.exec(hash);
  if (!match || match[1] === undefined) return { name: "workflows" };
  return { name: "workflow", id: decodeURIComponent(match[1]) };
}

export function workflowHref(id: string): string {
  return `#/workflows/${encodeURIComponent(id)}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
