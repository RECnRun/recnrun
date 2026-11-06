import { errorMessage } from "@recnrun/domain";
import type { Pin } from "@/p2p/pins";

type Source = "pairing" | "bootstrap" | "manual";

/** The stored role, as `storage/hierarchy-repository` validates it. */
type StoredRole =
  | {
      role: "worker";
      masterProfileId: string;
      masterIdentity: string;
      boundAt: number;
      source: Source;
    }
  | { role: "master"; profileId: string; identity: string }
  | { role: "template" };

/** What the profile section reads, each source validated at its storage boundary and read alone. */
export interface ProfileSources {
  version: string;
  granted: () => Promise<{ permissions: string[]; origins: string[] }>;
  identity: () => Promise<{ profileId: string; displayName: string } | null>;
  /** The public identity key when one exists; reading never creates it. */
  identityKey: () => Promise<string | null>;
  fingerprint: () => Promise<string | null>;
  bootId: () => Promise<string | null>;
  templateMode: () => Promise<boolean>;
  setting: () => Promise<string | null>;
  role: () => Promise<StoredRole | null>;
  boundWorkers: () => Promise<
    Record<string, { identity: string; boundAt: number; source: Source }>
  >;
  transport: () => Promise<Transport>;
  pins: () => Promise<Record<string, Pin>>;
}

interface Transport {
  namespace: string;
  root: string | null;
  policy: string | null;
  lastError: { at: number; message: string } | null;
  paused: string | null;
}

/** What `buildReport` already read for the E1 to E3 keys, so the section does not read twice. */
export interface Base {
  extensionId: string;
  mode: string;
  declared: string[];
  fileSchemeAccess: boolean;
  incognitoAccess: boolean;
}

/** Runs one read; a failure becomes null and a line in `errors`, never a thrown page. */
function softener(errors: string[]) {
  return async <T>(section: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      errors.push(`${section}: ${errorMessage(error)}`);
      return null;
    }
  };
}

type Soft = ReturnType<typeof softener>;

async function identityOf(sources: ProfileSources, soft: Soft) {
  const [stored, identityKey, certificateFingerprint] = await Promise.all([
    soft("identity.profile", sources.identity),
    soft("identity.identityKey", sources.identityKey),
    soft("identity.certificateFingerprint", sources.fingerprint),
  ]);
  return {
    profileId: stored?.profileId ?? null,
    displayName: stored?.displayName ?? null,
    identityKey,
    certificateFingerprint,
  };
}

async function roleOf(sources: ProfileSources) {
  const record = await sources.role();
  // A profile with no recorded role is a worker no master has bound yet.
  if (!record) return { role: "worker" };
  if (record.role === "worker") {
    return {
      role: record.role,
      masterProfileId: record.masterProfileId,
      masterIdentity: record.masterIdentity,
    };
  }
  if (record.role === "template") return { role: record.role };
  const bound = await sources.boundWorkers();
  const boundWorkers = Object.entries(bound).map(([profileId, { identity, boundAt }]) => ({
    profileId,
    identity,
    boundAt,
  }));
  return { role: record.role, boundWorkers };
}

async function permissionsOf(sources: ProfileSources, base: Base) {
  const { permissions, origins } = await sources.granted();
  return {
    declared: base.declared,
    granted: permissions,
    origins,
    fileSchemeAccess: base.fileSchemeAccess,
    incognitoAccess: base.incognitoAccess,
  };
}

async function peersOf(sources: ProfileSources) {
  const pins = await sources.pins();
  return Object.entries(pins)
    .map(([profileId, pin]) => ({
      profileId,
      identityKey: pin.identity,
      fingerprint: pin.fingerprint,
      source: pin.source,
      pinnedAt: pin.pinnedAt,
    }))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}

/** The POC profile section of the report: who this profile is, its role, and how it reaches peers. */
export async function buildProfile(sources: ProfileSources, base: Base) {
  const errors: string[] = [];
  const soft = softener(errors);
  const [identity, bootId, templateMode, setting, role, permissions, transport, peers] =
    await Promise.all([
      identityOf(sources, soft),
      soft("bootId", sources.bootId),
      soft("templateMode", sources.templateMode),
      soft("setting", sources.setting),
      soft("role", () => roleOf(sources)),
      soft("permissions", () => permissionsOf(sources, base)),
      soft("transport", async () => ({
        kind: "downloads" as const,
        ...(await sources.transport()),
      })),
      soft("peers", () => peersOf(sources)),
    ]);
  return {
    extension: { id: base.extensionId, version: sources.version, mode: base.mode },
    identity,
    bootId,
    templateMode,
    setting,
    role,
    permissions,
    transport,
    peers,
    errors,
  };
}
