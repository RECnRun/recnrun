/** What the diagnostics page needs of the extension APIs, injected so Node tests can stand in. */
export interface ReportSources {
  extensionId: string;
  mode: string;
  permissions: string[];
  isAllowedFileSchemeAccess(): Promise<boolean>;
  isAllowedIncognitoAccess(): Promise<boolean>;
}

/** The JSON the E1 to E3 specs read from `<pre id="diagnostics">`. */
export async function buildReport(sources: ReportSources) {
  const { permissions } = sources;
  return {
    extensionId: sources.extensionId,
    mode: sources.mode,
    permissions,
    fileSchemeAccess: await sources.isAllowedFileSchemeAccess(),
    incognitoAccess: await sources.isAllowedIncognitoAccess(),
    debuggerDeclared: permissions.includes("debugger"),
  };
}
