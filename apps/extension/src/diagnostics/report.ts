import { buildProfile } from "@/diagnostics/profile-report";
import type { ProfileSources } from "@/diagnostics/profile-report";

/** What the diagnostics page needs of the extension APIs, injected so Node tests can stand in. */
export interface ReportSources {
  extensionId: string;
  mode: string;
  permissions: string[];
  isAllowedFileSchemeAccess(): Promise<boolean>;
  isAllowedIncognitoAccess(): Promise<boolean>;
  /** The POC build's profile section; absent, the report keeps its E1 to E3 shape. */
  profile?: ProfileSources;
}

/** The JSON the E1 to E3 specs read from `<pre id="diagnostics">`. */
export async function buildReport(sources: ReportSources) {
  const { permissions } = sources;
  const legacy = {
    extensionId: sources.extensionId,
    mode: sources.mode,
    permissions,
    fileSchemeAccess: await sources.isAllowedFileSchemeAccess(),
    incognitoAccess: await sources.isAllowedIncognitoAccess(),
    debuggerDeclared: permissions.includes("debugger"),
  };
  if (!sources.profile) return legacy;
  const base = { ...legacy, declared: permissions };
  return { ...legacy, profile: await buildProfile(sources.profile, base) };
}
