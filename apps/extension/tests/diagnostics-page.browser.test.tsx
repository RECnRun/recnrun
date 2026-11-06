import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { DiagnosticsPage } from "@/diagnostics/DiagnosticsPage";

const MASTER = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const KEY = "B".repeat(87);

const report = {
  extensionId: "abc",
  mode: "poc-d0",
  permissions: ["storage", "downloads"],
  fileSchemeAccess: true,
  incognitoAccess: false,
  debuggerDeclared: false,
  profile: {
    extension: { id: "abc", version: "0.1.0", mode: "poc-d0" },
    identity: {
      profileId: WORKER,
      displayName: "Profile B",
      identityKey: KEY,
      certificateFingerprint: null,
    },
    bootId: null,
    templateMode: false,
    setting: "base-v1",
    role: { role: "worker", masterProfileId: MASTER, masterIdentity: KEY },
    permissions: {
      declared: ["storage", "downloads"],
      granted: [],
      origins: ["file:///*"],
      fileSchemeAccess: true,
      incognitoAccess: false,
    },
    transport: {
      kind: "downloads",
      namespace: "lab",
      root: null,
      policy: "baseline",
      lastError: { at: 7, message: "Chrome wrote nothing" },
      paused: null,
    },
    peers: [
      {
        profileId: MASTER,
        identityKey: KEY,
        fingerprint: "AB:CD",
        source: "pairing-code",
        pinnedAt: 4,
      },
      {
        profileId: "peer-2",
        identityKey: KEY,
        fingerprint: "EF:01",
        source: "manual",
        pinnedAt: 6,
      },
    ],
    errors: ["bootId: boom"],
  },
};

const FIELDS = [
  "extensionId",
  "mode",
  "permissions",
  "fileSchemeAccess",
  "incognitoAccess",
  "debuggerDeclared",
  "profile.extension.id",
  "profile.extension.version",
  "profile.extension.mode",
  "profile.identity.profileId",
  "profile.identity.displayName",
  "profile.identity.identityKey",
  "profile.identity.certificateFingerprint",
  "profile.bootId",
  "profile.templateMode",
  "profile.setting",
  "profile.role.role",
  "profile.role.masterProfileId",
  "profile.role.masterIdentity",
  "profile.permissions.declared",
  "profile.permissions.granted",
  "profile.permissions.origins",
  "profile.permissions.fileSchemeAccess",
  "profile.permissions.incognitoAccess",
  "profile.transport.kind",
  "profile.transport.namespace",
  "profile.transport.root",
  "profile.transport.policy",
  "profile.transport.lastError.at",
  "profile.transport.lastError.message",
  "profile.transport.paused",
  ...[0, 1].flatMap((index) =>
    ["profileId", "identityKey", "fingerprint", "source", "pinnedAt"].map(
      (key) => `profile.peers.${index}.${key}`,
    ),
  ),
  "profile.errors",
];

function mount(shown: object) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<DiagnosticsPage report={shown} />, root);
  return root;
}

const value = (root: HTMLElement, field: string) =>
  root.querySelector(`[data-field="${field}"]`)?.textContent;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
});

test("renders every field of the report, and no other, under a heading per section", () => {
  const root = mount(report);
  const fields = [...root.querySelectorAll("[data-field]")].map((each) =>
    each.getAttribute("data-field"),
  );
  expect(fields).toEqual(FIELDS);
  const headings = [...root.querySelectorAll("section > h2")].map((each) => each.textContent);
  expect(headings).toEqual([
    "Build",
    "extension",
    "identity",
    "bootId",
    "templateMode",
    "setting",
    "role",
    "permissions",
    "transport",
    "peers",
    "errors",
  ]);
});

test("shows the values as the report holds them", () => {
  const root = mount(report);
  expect(value(root, "profile.identity.profileId")).toBe(WORKER);
  expect(value(root, "profile.identity.identityKey")).toBe(KEY);
  expect(value(root, "profile.templateMode")).toBe("false");
  expect(value(root, "profile.setting")).toBe("base-v1");
  expect(value(root, "profile.role.masterProfileId")).toBe(MASTER);
  expect(value(root, "profile.permissions.declared")).toBe("storage, downloads");
  expect(value(root, "profile.transport.lastError.message")).toBe("Chrome wrote nothing");
  expect(value(root, "profile.errors")).toBe("bootId: boom");
});

test("shows what the report could not read as unknown, and an empty list as none", () => {
  const root = mount(report);
  for (const field of [
    "profile.identity.certificateFingerprint",
    "profile.bootId",
    "profile.transport.root",
    "profile.transport.paused",
  ]) {
    expect(value(root, field), field).toBe("unknown");
  }
  expect(value(root, "profile.permissions.granted")).toBe("none");
});

test("lists each pinned peer with its pinned key", () => {
  const root = mount(report);
  expect(value(root, "profile.peers.0.profileId")).toBe(MASTER);
  expect(value(root, "profile.peers.1.profileId")).toBe("peer-2");
  expect(value(root, "profile.peers.1.identityKey")).toBe(KEY);
});

test("shows a section that failed to read as one unknown field", () => {
  const root = mount({ ...report, profile: { ...report.profile, role: null, peers: null } });
  expect(value(root, "profile.role")).toBe("unknown");
  expect(value(root, "profile.peers")).toBe("unknown");
});
