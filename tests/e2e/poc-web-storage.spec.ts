import { BLANK, closeWorkspace, openBlank } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, startFromCapture } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { storageSizes, webStorageIn } from "./fixtures/web-storage.ts";
import { pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

test("the managed tab's localStorage and sessionStorage come back entry for entry", async ({
  context,
  serviceWorker,
}) => {
  const source = await openBlank(context, serviceWorker);
  const written = await webStorageIn(source, true);
  expect(written.localStorage.mismatched).toEqual([]);
  expect(written.sessionStorage.mismatched).toEqual([]);
  const summary = await captureIdentity(serviceWorker, "identity-a");
  expect(summary).toMatchObject({ localStorage: 7, sessionStorage: 8, databases: 0, records: 0 });
  await closeWorkspace(serviceWorker, source);

  // Another identity starts empty: nothing of the first leaks into it.
  const other = await openBlank(context, serviceWorker);
  await expect(storageSizes(other)).resolves.toEqual({ localStorage: 0, sessionStorage: 0 });
  await closeWorkspace(serviceWorker, other);

  const timings = await startFromCapture(serviceWorker, "identity-a");
  const restored = await pageAt(context, BLANK);
  await expect(webStorageIn(restored, false)).resolves.toEqual(written);
  await closeWorkspace(serviceWorker, restored);

  await keep("capture-web-storage", {
    summary,
    restoreTimings: timings,
    sizes: {
      localStorage: { entries: written.localStorage.entries, chars: written.localStorage.chars },
      sessionStorage: {
        entries: written.sessionStorage.entries,
        chars: written.sessionStorage.chars,
      },
    },
  });
});
