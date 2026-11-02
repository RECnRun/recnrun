/** The screens, addressed by `location.hash` so the service serves a single page. */
export type Route =
  | { screen: "setup" }
  | { screen: "catalog" }
  | { screen: "recorder" }
  | { screen: "editor"; flowId: string }
  | { screen: "run"; flowId: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const [head, flowId, tail] = parts;
  if (head === "setup") return { screen: "setup" };
  if (head === "record") return { screen: "recorder" };
  if (head === "flows" && flowId) {
    return tail === "run" ? { screen: "run", flowId } : { screen: "editor", flowId };
  }
  return { screen: "catalog" };
}

export function hrefOf(route: Route): string {
  switch (route.screen) {
    case "setup":
      return "#/setup";
    case "catalog":
      return "#/flows";
    case "recorder":
      return "#/record";
    case "editor":
      return `#/flows/${encodeURIComponent(route.flowId)}`;
    case "run":
      return `#/flows/${encodeURIComponent(route.flowId)}/run`;
  }
}
