import { browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";

/** The APIs behind the permissions a production build does not declare (OD-1). */
const WORKSPACE_APIS = ["cookies", "declarativeNetRequest", "scripting", "webNavigation"] as const;

/** Whether Chrome exposes every API the workspace needs; it hides each one without its permission. */
export function workspaceAvailable(api: object = browser): boolean {
  const exposed: Partial<Record<(typeof WORKSPACE_APIS)[number], unknown>> = api;
  return WORKSPACE_APIS.every((name) => exposed[name] !== undefined);
}

/** The refusal of every workspace command in a build that cannot run the workspace. */
export function workspaceUnavailable(): WorkspaceError {
  return new WorkspaceError(
    "CookiesUnavailable",
    "This build of RECnRun cannot tell when Chrome has cleared an Incognito session.",
  );
}
