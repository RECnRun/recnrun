import { readFileSync } from "node:fs";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { presencePath, registryPath } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS, PresenceSchema } from "@/p2p/folder-rendezvous";
import {
  MAX_REGISTRY_PEERS,
  REGISTRY_TTL_MS,
  RegistrationNameSchema,
  RegistrationSchema,
  RegistrySchema,
  readRegistry,
  registrationName,
} from "@/p2p/registry";
import type { Registry } from "@/p2p/registry";
import { FINGERPRINT, ME, PEER } from "./fake-peer";

const NOW = 1_700_000_000_000;
const BOOT = "44444444-4444-4444-8444-444444444444";

const registration = {
  profileId: PEER,
  displayName: "Desk",
  fingerprint: FINGERPRINT,
  createdAt: NOW - 1000,
  expiresAt: NOW - 1000 + PRESENCE_TTL_MS,
  namespace: "lab-1",
  boot: BOOT,
};

const peer = (profileId: string, root = "r1") => ({
  profileId,
  displayName: "Desk",
  fingerprint: FINGERPRINT,
  root,
  lastSeenAt: NOW - 500,
  expiresAt: NOW + PRESENCE_TTL_MS,
  boot: BOOT,
});

function registry(overrides: Partial<Registry> = {}): Registry {
  return {
    version: 1,
    namespace: "lab-1",
    writtenAt: NOW - 1000,
    launcher: { boot: BOOT },
    peers: { [PEER]: peer(PEER), [ME]: peer(ME, "r2") },
    ...overrides,
  };
}

/** A uuid per index, so a test can make as many distinct peers as it needs. */
const profileIdAt = (index: number) =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

describe("RegistrationSchema", () => {
  test("accepts a presence plus its namespace and the boot of the process", () => {
    expect(v.parse(RegistrationSchema, registration)).toEqual(registration);
  });

  test.each(["path", "root", "userDataDir", "directory", "filename"])(
    "refuses a registration that names a location in %j",
    (key) => {
      expect(v.is(RegistrationSchema, { ...registration, [key]: "/Users/me/Downloads" })).toBe(
        false,
      );
    },
  );

  test.each([
    ["namespace", "a/b"],
    ["namespace", "../up"],
    ["boot", "not-a-uuid"],
    ["profileId", "Profile 2"],
    ["displayName", "x".repeat(65)],
  ])("refuses the %s %j", (key, value) => {
    expect(v.is(RegistrationSchema, { ...registration, [key]: value })).toBe(false);
  });

  test("has the presence's entries in its order, then the namespace and the boot", () => {
    expect(Object.keys(RegistrationSchema.entries)).toEqual([
      ...Object.keys(PresenceSchema.entries),
      "namespace",
      "boot",
    ]);
    for (const [key, schema] of Object.entries(PresenceSchema.entries)) {
      expect(RegistrationSchema.entries[key as keyof typeof PresenceSchema.entries].type).toBe(
        schema.type,
      );
    }
  });

  test.each([
    ["expires before it is created", NOW, NOW - 1],
    ["expires as it is created", NOW, NOW],
    ["lives a week", NOW, NOW + 7 * 86_400_000],
    ["lives one millisecond over the TTL", NOW, NOW + PRESENCE_TTL_MS + 1],
  ])("refuses a registration that %s", (_name, createdAt, expiresAt) => {
    expect(v.is(RegistrationSchema, { ...registration, createdAt, expiresAt })).toBe(false);
  });

  test("accepts a registration that lives exactly the TTL", () => {
    const exact = { ...registration, createdAt: NOW, expiresAt: NOW + PRESENCE_TTL_MS };
    expect(v.is(RegistrationSchema, exact)).toBe(true);
  });

  test("refuses a registration without its boot", () => {
    const { boot: _boot, ...presence } = registration;
    expect(v.is(RegistrationSchema, presence)).toBe(false);
  });
});

describe("RegistrationNameSchema", () => {
  // catalog.checks.mjs runs catalog.sh over the same table, so both sides list the same names.
  const table = new URL(
    "../../../scripts/poc-cross-profile/fixtures/display-names.json",
    import.meta.url,
  );
  const names: { name: string; accepted: boolean }[] = JSON.parse(readFileSync(table, "utf8"));

  test.each(names)("decides $name as catalog.sh does: $accepted", ({ name, accepted }) => {
    expect(v.is(RegistrationNameSchema, name)).toBe(accepted);
    expect(v.is(RegistrationSchema, { ...registration, displayName: name })).toBe(accepted);
  });

  test("keeps a name the catalog lists and replaces one it skips by the default name", () => {
    expect(registrationName(PEER, "José's Mac")).toBe("José's Mac");
    expect(registrationName(PEER, 'My "Mac"')).toBe("Profile 2222");
    expect(registrationName("abcdef01-2222-4222-8222-222222222222", "é".repeat(40))).toBe(
      "Profile ABCD",
    );
  });
});

describe("RegistrySchema", () => {
  test("accepts the catalog the launcher writes, with or without its fingerprint", () => {
    expect(v.parse(RegistrySchema, registry())).toEqual(registry());
    const pinned = registry({ launcher: { boot: BOOT, fingerprint: FINGERPRINT } });
    expect(v.parse(RegistrySchema, pinned)).toEqual(pinned);
    expect(v.is(RegistrySchema, registry({ peers: {} }))).toBe(true);
  });

  test.each(["/Users/me/Downloads", "r", "r1000", "R1", "root1", "r1/..", "1"])(
    "refuses the root %j, which is not an opaque id",
    (root) => {
      expect(v.is(RegistrySchema, registry({ peers: { [PEER]: peer(PEER, root) } }))).toBe(false);
    },
  );

  test("refuses a peer without the boot of its registration", () => {
    const { boot: _boot, ...unbooted } = peer(PEER);
    expect(v.is(RegistrySchema, registry({ peers: { [PEER]: unbooted as never } }))).toBe(false);
    const badBoot = { ...peer(PEER), boot: "not-a-uuid" };
    expect(v.is(RegistrySchema, registry({ peers: { [PEER]: badBoot } }))).toBe(false);
  });

  test("refuses a peer filed under another profile's id", () => {
    expect(v.is(RegistrySchema, registry({ peers: { [ME]: peer(PEER) } }))).toBe(false);
  });

  test("refuses a peer key that is not a profile id", () => {
    expect(v.is(RegistrySchema, registry({ peers: { "Profile 2": peer(PEER) } }))).toBe(false);
  });

  test(`holds at most ${MAX_REGISTRY_PEERS} peers`, () => {
    const peers = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [profileIdAt(index), peer(profileIdAt(index))]),
      );
    expect(MAX_REGISTRY_PEERS).toBe(32);
    expect(v.is(RegistrySchema, registry({ peers: peers(32) }))).toBe(true);
    expect(v.is(RegistrySchema, registry({ peers: peers(33) }))).toBe(false);
  });

  test.each([
    ["an unknown key", { ...registry(), path: "/tmp" }],
    ["another version", { ...registry(), version: 2 }],
    [
      "a peer with a path",
      registry({ peers: { [PEER]: { ...peer(PEER), path: "/tmp" } as never } }),
    ],
    ["a launcher with a path", registry({ launcher: { boot: BOOT, path: "/tmp" } as never })],
    ["a fractional time", registry({ writtenAt: NOW + 0.5 })],
  ])("refuses %s", (_name, value) => {
    expect(v.is(RegistrySchema, value)).toBe(false);
  });
});

describe("the catalog scripts/poc-cross-profile/catalog.sh writes", () => {
  test("validates against RegistrySchema", () => {
    // catalog.checks.mjs regenerates this sample from a run of the script.
    const sample = new URL(
      "../../../scripts/poc-cross-profile/fixtures/registry.sample.json",
      import.meta.url,
    );
    const registry = v.parse(RegistrySchema, JSON.parse(readFileSync(sample, "utf8")));
    expect(Object.values(registry.peers).map((each) => each.root)).toEqual(["r1", "r2"]);
  });
});

describe("readRegistry", () => {
  const previous = registry();

  test("lives twice as long as a presence", () => {
    expect(REGISTRY_TTL_MS).toBe(2 * PRESENCE_TTL_MS);
  });

  test("takes a fresh valid catalog", () => {
    const next = registry({ writtenAt: NOW });
    expect(readRegistry(JSON.stringify(next), previous, NOW)).toEqual({
      publication: next,
      reason: "fresh",
    });
    expect(readRegistry(JSON.stringify(next), undefined, NOW).publication).toEqual(next);
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["partial", JSON.stringify(registry()).slice(0, -1)],
    ["invalid", JSON.stringify({ version: 0 })],
    ["older", JSON.stringify(registry({ writtenAt: NOW - 2000 }))],
    ["invalid", JSON.stringify(registry({ writtenAt: NOW + 60_000 }))],
  ])("keeps the previous catalog when the file is %s", (reason, text) => {
    expect(readRegistry(text, previous, NOW)).toEqual({ publication: previous, reason });
  });

  test("drops a catalog past its TTL", () => {
    const expired = registry({ writtenAt: NOW - REGISTRY_TTL_MS });
    expect(readRegistry(JSON.stringify(expired), undefined, NOW)).toEqual({
      publication: undefined,
      reason: "expired",
    });
  });

  test("the previous catalog stands only until its TTL", () => {
    const later = previous.writtenAt + REGISTRY_TTL_MS;
    expect(readRegistry(undefined, previous, later)).toEqual({
      publication: undefined,
      reason: "absent",
    });
    expect(readRegistry("{", previous, later - 1).publication).toEqual(previous);
  });

  test("accepts a catalog stamped within a small clock skew", () => {
    const skewed = registry({ writtenAt: NOW + 1000 });
    expect(readRegistry(JSON.stringify(skewed), undefined, NOW).reason).toBe("fresh");
  });
});

describe("rendezvous paths", () => {
  test("put the catalog and each presence under RECnRun/poc/<namespace>/", () => {
    expect(registryPath("lab-1")).toBe("RECnRun/poc/lab-1/registry.json");
    expect(presencePath("lab-1", PEER)).toBe(`RECnRun/poc/lab-1/peers/${PEER}/presence.json`);
  });

  test.each(["", "A", "a/b", ".."])("refuse the namespace %j", (namespace) => {
    expect(() => registryPath(namespace)).toThrow(/namespace/);
    expect(() => presencePath(namespace, PEER)).toThrow(/namespace/);
  });

  test.each(["", "..", "Profile 2", `${PEER}/..`, "../x"])(
    "refuse the profile id %j",
    (profileId) => {
      expect(() => presencePath("lab-1", profileId)).toThrow(/profile id/);
    },
  );
});
