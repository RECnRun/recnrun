import { browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { WEB_HOSTS } from "@/config/permissions";

/**
 * Whether the user leaves RECnRun on all sites. "On click" and "On specific sites" withhold hosts,
 * which `permissions.contains` leaves out of the active set (`permissions_api.cc:167-188`), and
 * `cookies.getAll` then drops their cookies.
 */
export function hasSiteAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: WEB_HOSTS });
}

/** The refusal of every workspace command while the user withholds site access. */
export function siteAccessWithheld(): WorkspaceError {
  return new WorkspaceError(
    "SiteAccessWithheld",
    "Set RECnRun's Site access to “On all sites” in its details in chrome://extensions, so it can save every site's cookies.",
  );
}
