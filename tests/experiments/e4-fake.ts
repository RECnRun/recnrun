import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedExtension } from "../browser/fixtures/extension-loaders.ts";
import { namespaceFolder, writePresence } from "./fixtures/e4-launcher.ts";
import type { PresenceFile } from "./fixtures/e4-launcher.ts";
import type { E4Environment, E4Profile, E4Session } from "./fixtures/e4-profiles.ts";

/*
 * An E4 environment with no Chrome, for the harness's unit tests: each profile is a fake whose
 * presence the test writes into real temporary folders, so the launcher's scan and catalog.sh run
 * unchanged. `onOpen` stands for what the extension does when the launcher opens its bootstrap page.
 */

interface FakeProfile {
  profile: E4Profile;
  presence: PresenceFile;
  /** The folder its fake Chrome downloads to. */
  downloads: string;
}

export type OnOpen = (opened: FakeProfile, token: string) => Promise<void>;

/** The extension's answer to a bootstrap opening: its presence again, with the token as its boot. */
export const announceToken: OnOpen = async (opened, token) => {
  opened.presence = { ...opened.presence, boot: token };
  await writePresence(opened.downloads, opened.presence);
};

/** Writes `presence` under `downloads`, creating its profile folder. */
export async function placePresence(downloads: string, presence: PresenceFile) {
  await mkdir(join(namespaceFolder(downloads), "peers", presence.profileId), { recursive: true });
  await writePresence(downloads, presence);
}

export const freshPresence = (profileId = randomUUID()): PresenceFile => ({
  profileId,
  displayName: "Fake profile",
  fingerprint: "AB:CD",
  // Well formed for catalog.sh, which checks no signature; no real profile would trust it.
  identity: { key: "B".repeat(87), signedAt: Date.now(), signature: "S".repeat(86) },
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  namespace: "lab",
  boot: randomUUID(),
});

/** What the profile's diagnostics page reads: registry.json under its own folder, or none. */
async function ownRegistry(downloads: string) {
  const text = await readFile(join(namespaceFolder(downloads), "registry.json"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return { reason: "absent", namespace: "lab", peers: [] };
  const peers = Object.values((JSON.parse(text) as { peers: Record<string, unknown> }).peers);
  return { reason: "fresh", namespace: "lab", peers };
}

function fakeInstalled(fake: () => FakeProfile): LoadedExtension {
  const page = {
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async () => ownRegistry(fake().downloads),
    close: async () => undefined,
  };
  const chrome = {
    cdp: { send: async () => ({ targetInfos: [] }) },
    browser: { contexts: () => [{ newPage: async () => page }] },
  };
  const evaluateInBackground = async () => ({
    profileId: fake().presence.profileId,
    boot: fake().presence.boot,
    root: fake().downloads,
  });
  return {
    chrome,
    evaluateInBackground,
    close: async () => undefined,
  } as unknown as LoadedExtension;
}

/** A session over a temporary folder; every profile announces itself where it downloads. */
export async function fakeSession(onOpen: OnOpen = announceToken) {
  const scratch = await mkdtemp(join(tmpdir(), "recnrun-e4-fake-"));
  let folders = 0;
  const folder = async (name: string) => {
    const path = join(scratch, `${name}-${++folders}`);
    await mkdir(path);
    return path;
  };
  const fakes = new Map<E4Profile, FakeProfile>();
  const defaultDownloads = await folder("default");
  const session: E4Session = {
    defaultDownloads,
    realDefault: true,
    folder,
    record: join(await folder("launcher"), "record"),
    launch: async (name, downloads) => {
      const root = await folder(`profile-${name}`);
      const folderPreference = downloads ? { default_directory: downloads } : {};
      await mkdir(join(root, "Default"));
      const preferences = JSON.stringify({ download: folderPreference });
      await writeFile(join(root, "Default", "Preferences"), preferences);
      const where = downloads ?? defaultDownloads;
      const fake = { presence: freshPresence(), downloads: where } as FakeProfile;
      fake.profile = {
        name,
        root,
        profileDirectory: "Default",
        installed: fakeInstalled(() => fake),
      };
      fakes.set(fake.profile, fake);
      await placePresence(where, fake.presence);
      return fake.profile;
    },
    open: async (profile, url) => {
      const fake = fakes.get(profile);
      if (!fake) throw new Error(`${profile.name} was not launched in this session`);
      await onOpen(fake, new URL(url).hash.replace("#token=", ""));
      return { code: 0, stopped: false };
    },
    quit: async () => undefined,
    dispose: () => rm(scratch, { recursive: true, force: true }),
  };
  return { session, fakes };
}

/** An environment whose every session is a new fake session. */
export const fakeEnvironment = (onOpen?: OnOpen): E4Environment => ({
  target: { environment: "lab", chrome: async () => "Fake Chrome" },
  session: async () => (await fakeSession(onOpen)).session,
});
