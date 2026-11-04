import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { UnavailableError } from "../browser/fixtures/policy-install.ts";
import { freshPresence, fakeEnvironment, placePresence } from "./e4-fake.ts";
import { preferencesSample } from "./e4-samples.ts";
import { launcherIo, namespaceFolder, presencesIn, runCatalog } from "./fixtures/e4-launcher.ts";
import { createSession } from "./fixtures/e4-profiles.ts";

// Codex P2 finding 5: expected absence is no presence; any other failure is the harness's error.
let scratch = "";
const errno = (code: string, message = code) => Object.assign(new Error(message), { code });

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "recnrun-e4-launcher-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("E4 launcher scan", () => {
  test("a Downloads folder with no peers folder holds no presence", async () => {
    await expect(presencesIn(join(scratch, "missing"))).resolves.toEqual([]);
  });

  test("a profile folder with no presence.json, or one of another shape, counts as none", async () => {
    const valid = freshPresence();
    await placePresence(scratch, valid);
    const peers = join(namespaceFolder(scratch), "peers");
    await mkdir(join(peers, randomUUID()));
    const other = join(peers, randomUUID());
    await mkdir(other);
    await writeFile(join(other, "presence.json"), JSON.stringify({ profileId: "x" }));
    await expect(presencesIn(scratch)).resolves.toEqual([valid]);
  });

  test("a peers folder that cannot be listed is a harness error", async () => {
    vi.spyOn(launcherIo, "readdir").mockRejectedValue(errno("EACCES"));
    await expect(presencesIn(scratch)).rejects.toThrow("EACCES");
  });

  test("a presence.json that cannot be read is a harness error", async () => {
    await placePresence(scratch, freshPresence());
    vi.spyOn(launcherIo, "readFile").mockRejectedValue(errno("EACCES"));
    await expect(presencesIn(scratch)).rejects.toThrow("EACCES");
  });

  test("a presence.json that exists but is not JSON is a harness error", async () => {
    const presence = freshPresence();
    await placePresence(scratch, presence);
    const file = join(namespaceFolder(scratch), "peers", presence.profileId, "presence.json");
    await writeFile(file, "{");
    await expect(presencesIn(scratch)).rejects.toThrow(SyntaxError);
  });
});

describe("E4 launcher processes", () => {
  const failWith = (error: unknown) =>
    vi.spyOn(launcherIo, "execFile").mockImplementation((_file, _args, callback) => {
      callback(error as never, "", "");
    });

  test("catalog.sh's own exit code is a result", async () => {
    failWith(Object.assign(new Error("exit 73"), { code: 73 }));
    await expect(runCatalog(join(scratch, "record"), scratch)).resolves.toMatchObject({ code: 73 });
  });

  test("sh that cannot start is a harness error", async () => {
    failWith(errno("ENOENT", "spawn sh ENOENT"));
    await expect(runCatalog(join(scratch, "record"), scratch)).rejects.toThrow("spawn sh ENOENT");
  });

  test("a run with no numeric exit code is a harness error", async () => {
    failWith(Object.assign(new Error("killed"), { code: null, signal: "SIGKILL" }));
    await expect(runCatalog(join(scratch, "record"), scratch)).rejects.toThrow("killed");
  });

  test("an opening whose Chrome cannot start is a harness error", async () => {
    const session = await createSession({
      defaultDownloads: scratch,
      realDefault: false,
      makeFolder: (name) => mkdtemp(join(scratch, `${name}-`)),
      removeFolder: (path) => rm(path, { recursive: true, force: true }),
      launch: () => Promise.reject(new Error("no Chrome in a unit test")),
      binary: join(scratch, "no-chrome"),
      openArgs: [],
      cleanup: async () => undefined,
    });
    const profile = { name: "A", root: scratch } as Parameters<typeof session.open>[0];
    await expect(session.open(profile, "about:blank")).rejects.toThrow("ENOENT");
    await session.dispose();
  });
});

describe("E4.c native reader", () => {
  test("a reader's value is the measurement: P's own folder passes, nothing fails", async () => {
    const own = async (root: string) => {
      const text = await readFile(join(root, "Default", "Preferences"), "utf8");
      return (JSON.parse(text) as { download: { default_directory: string } }).download
        .default_directory;
    };
    await expect(preferencesSample(fakeEnvironment(), own)).resolves.toMatchObject({ ok: true });
    const none = async () => null;
    await expect(preferencesSample(fakeEnvironment(), none)).resolves.toMatchObject({ ok: false });
  });

  test("a reader that cannot start is a harness error", async () => {
    const reader = () => Promise.reject(errno("ENOENT", "spawn plutil ENOENT"));
    await expect(preferencesSample(fakeEnvironment(), reader)).rejects.toThrow(
      "spawn plutil ENOENT",
    );
  });

  test("only an explicitly unavailable reader is unavailable", async () => {
    const reader = () => Promise.reject(new UnavailableError("no native reader"));
    await expect(preferencesSample(fakeEnvironment(), reader)).rejects.toBeInstanceOf(
      UnavailableError,
    );
  });
});
