/** Where the build writes the bootstrap module that a module service worker imports first. */
export const MODULE_BOOTSTRAP_PATH = "route-b/bootstrap.js";

/**
 * The web-accessible module: the marker comes from its own URL, so one file serves every marker and
 * the importing script stays byte-stable for a given marker and body.
 */
export function renderModuleResource(source: string): string {
  return [
    'const marker = new URL(import.meta.url).searchParams.get("marker");',
    `${source}({ marker });`,
    "",
  ].join("\n");
}
