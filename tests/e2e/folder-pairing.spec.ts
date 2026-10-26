import type { Page } from "@playwright/test";
import { expect } from "./fixtures/extension.ts";
import { test } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";

/*
 * Playwright cannot drive Chrome's folder picker (H4), so each pairing page picks a RECnRun
 * folder in its profile's private file system, and the test copies each profile's own files
 * into the other's, as one folder on disk would show them to both.
 */

type Files = Record<string, string>;

interface ChromeGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

const profileIdOf = (profile: Profile) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return (profileIdentity as { profileId: string }).profileId;
  });

/** The files profile `owner` keeps in its own pairing folder, as `from` sees them. */
const readOwn = (from: Profile, owner: string) =>
  from.serviceWorker.evaluate(async (id) => {
    const files: Record<string, string> = {};
    const root = await navigator.storage.getDirectory();
    const recnrun = await root.getDirectoryHandle("RECnRun").catch(() => undefined);
    const pairing = await recnrun?.getDirectoryHandle("pairing").catch(() => undefined);
    const own = await pairing?.getDirectoryHandle(id).catch(() => undefined);
    for await (const [name, handle] of own?.entries() ?? []) {
      if (handle instanceof FileSystemFileHandle)
        files[name] = await (await handle.getFile()).text();
    }
    return files;
  }, owner);

/** Makes profile `owner`'s pairing folder in `to` hold exactly `files`. */
const writeOwn = (to: Profile, owner: string, files: Files) =>
  to.serviceWorker.evaluate(
    async ({ id, wanted }) => {
      const root = await navigator.storage.getDirectory();
      const recnrun = await root.getDirectoryHandle("RECnRun", { create: true });
      const pairing = await recnrun.getDirectoryHandle("pairing", { create: true });
      const own = await pairing.getDirectoryHandle(id, { create: true });
      for await (const name of own.keys()) if (!(name in wanted)) await own.removeEntry(name);
      for (const [name, content] of Object.entries(wanted)) {
        const writable = await (await own.getFileHandle(name, { create: true })).createWritable();
        await writable.write(content);
        await writable.close();
      }
    },
    { id: owner, wanted: files },
  );

interface Side {
  profile: Profile;
  id: string;
}

/** Copies each profile's own files to the other every 250 ms, until the returned stop. */
function mirror(a: Side, b: Side) {
  const copied = new Map<string, string>();
  const copy = async (from: Side, to: Side) => {
    const files = await readOwn(from.profile, from.id);
    const key = JSON.stringify(files);
    if (copied.get(from.id) === key) return;
    await writeOwn(to.profile, from.id, files);
    copied.set(from.id, key);
  };
  const stopped = new AbortController();
  const loop = (async () => {
    while (!stopped.signal.aborted) {
      await copy(a, b);
      await copy(b, a);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return async () => {
    stopped.abort();
    await loop;
  };
}

const folderSection = (page: Page) => page.locator('section[aria-labelledby="folder-heading"]');

/** Chooses the folder on the pairing page, the picker answering with the private RECnRun. */
async function chooseFolder(page: Page) {
  await page.evaluate(() => {
    const showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("RECnRun", { create: true });
    Object.assign(window, { showDirectoryPicker });
  });
  await page.getByRole("button", { name: "Choose folder" }).click();
}

test("two profiles pair through the RECnRun folder once each chose it, with no page left open", async ({
  profileA,
  profileB,
}) => {
  const a = { profile: profileA, id: await profileIdOf(profileA) };
  const b = { profile: profileB, id: await profileIdOf(profileB) };
  const stop = mirror(a, b);
  try {
    await chooseFolder(profileA.pairing);
    await expect(folderSection(profileA.pairing)).toContainText(
      "Waiting for another profile in the folder…",
    );
    // H2: A's offscreen document keeps waiting with none of A's pages open.
    await profileA.pairing.close();
    await chooseFolder(profileB.pairing);
    await expect(profileB.pairing.getByRole("status")).toHaveText(`Connected — ${profileA.name}`, {
      timeout: 30_000,
    });
    await expect(folderSection(profileB.pairing)).toContainText(`Paired with ${profileA.name}`);
    const again = await profileA.context.newPage();
    await again.goto(new URL("pairing.html", profileA.serviceWorker.url()).href);
    await expect(again.getByRole("status")).toHaveText(`Connected — ${profileB.name}`);
  } finally {
    await stop();
  }
  // Once paired, each profile leaves nothing of its own in the folder.
  for (const side of [a, b]) await expect.poll(() => readOwn(side.profile, side.id)).toEqual({});
});
