import { describe, expect, test } from "vite-plus/test";
import { buildReport } from "@/diagnostics/report";
import type { ReportSources } from "@/diagnostics/report";
import type { ProfileSources } from "@/diagnostics/profile-report";

const KEY = "B".repeat(87);
const OTHER_KEY = "C".repeat(87);
const MASTER = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");

const profile = (overrides: Partial<ProfileSources> = {}): ProfileSources => ({
  version: "0.1.0",
  granted: async () => ({ permissions: ["storage", "downloads"], origins: ["file:///*"] }),
  identity: async () => ({ profileId: WORKER, displayName: "Profile B" }),
  identityKey: async () => KEY,
  fingerprint: async () => FINGERPRINT,
  bootId: async () => "33333333-3333-4333-8333-333333333333",
  templateMode: async () => false,
  setting: async () => null,
  role: async () => ({
    role: "worker",
    masterProfileId: MASTER,
    masterIdentity: OTHER_KEY,
    boundAt: 5,
    source: "pairing",
  }),
  boundWorkers: async () => ({}),
  transport: async () => ({
    namespace: "lab",
    root: "/home/user/Downloads",
    policy: "baseline",
    lastError: { at: 7, message: "Chrome wrote nothing" },
    paused: "disconnect",
  }),
  pins: async () => ({
    [MASTER]: {
      fingerprint: FINGERPRINT,
      pinnedAt: 4,
      source: "pairing-code",
      identity: OTHER_KEY,
    },
  }),
  ...overrides,
});

const sources = (extra: Partial<ProfileSources> = {}): ReportSources => ({
  extensionId: "abc",
  mode: "poc-d0",
  permissions: ["storage", "downloads"],
  isAllowedFileSchemeAccess: async () => true,
  isAllowedIncognitoAccess: async () => false,
  profile: profile(extra),
});

const section = async (extra: Partial<ProfileSources> = {}) => {
  const { profile: built } = (await buildReport(sources(extra))) as never as {
    profile: Record<string, unknown>;
  };
  return built;
};

describe("buildReport profile section", () => {
  test("keeps the E1 to E3 shape when no profile sources are given", async () => {
    const { profile: _unused, ...rest } = sources();
    expect(Object.keys(await buildReport(rest))).toEqual([
      "extensionId",
      "mode",
      "permissions",
      "fileSchemeAccess",
      "incognitoAccess",
      "debuggerDeclared",
    ]);
  });

  test("reports the extension, identity, boot, template mode, and setting", async () => {
    expect(await section()).toMatchObject({
      extension: { id: "abc", version: "0.1.0", mode: "poc-d0" },
      identity: {
        profileId: WORKER,
        displayName: "Profile B",
        identityKey: KEY,
        certificateFingerprint: FINGERPRINT,
      },
      bootId: "33333333-3333-4333-8333-333333333333",
      templateMode: false,
      setting: null,
      errors: [],
    });
  });

  test("reports a worker's master and a master's bound workers", async () => {
    expect((await section()).role).toEqual({
      role: "worker",
      masterProfileId: MASTER,
      masterIdentity: OTHER_KEY,
    });
    const master = await section({
      role: async () => ({ role: "master", profileId: MASTER, identity: KEY }),
      boundWorkers: async () => ({
        [WORKER]: { identity: OTHER_KEY, boundAt: 9, source: "pairing" },
      }),
    });
    expect(master.role).toEqual({
      role: "master",
      boundWorkers: [{ profileId: WORKER, identity: OTHER_KEY, boundAt: 9 }],
    });
  });

  test("reads an unbound profile as a worker and a template as itself", async () => {
    expect((await section({ role: async () => null })).role).toEqual({ role: "worker" });
    expect((await section({ role: async () => ({ role: "template" }) })).role).toEqual({
      role: "template",
    });
  });

  test("reports the permissions, the transport, and the pinned peers", async () => {
    const built = await section();
    expect(built.permissions).toEqual({
      declared: ["storage", "downloads"],
      granted: ["storage", "downloads"],
      origins: ["file:///*"],
      fileSchemeAccess: true,
      incognitoAccess: false,
    });
    expect(built.transport).toEqual({
      kind: "downloads",
      namespace: "lab",
      root: "/home/user/Downloads",
      policy: "baseline",
      lastError: { at: 7, message: "Chrome wrote nothing" },
      paused: "disconnect",
    });
    expect(built.peers).toEqual([
      {
        profileId: MASTER,
        identityKey: OTHER_KEY,
        fingerprint: FINGERPRINT,
        source: "pairing-code",
        pinnedAt: 4,
      },
    ]);
  });

  test("fails soft: a section that cannot be read is null and named in errors", async () => {
    const failing = () => Promise.reject(new Error("boom"));
    const built = await section({
      identityKey: failing,
      bootId: failing,
      role: failing,
      pins: failing,
      transport: failing,
      granted: failing,
    });
    expect(built).toMatchObject({
      identity: { identityKey: null, certificateFingerprint: FINGERPRINT },
      bootId: null,
      role: null,
      peers: null,
      transport: null,
      permissions: null,
    });
    expect(built.errors).toEqual(
      expect.arrayContaining([
        "identity.identityKey: boom",
        "bootId: boom",
        "role: boom",
        "peers: boom",
        "transport: boom",
        "permissions: boom",
      ]),
    );
  });

  test("holds no secret: no token, operation id, private key, or signature", async () => {
    const text = JSON.stringify(await buildReport(sources()));
    expect(text).not.toMatch(/"(token|operationId|privateKey|secret)"/i);
    expect(text).not.toMatch(/(?<![\w-])[\w-]{86}(?![\w-])/);
    expect(text).toContain(KEY);
  });
});
