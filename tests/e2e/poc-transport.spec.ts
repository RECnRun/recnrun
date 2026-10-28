import { readFileSync } from "node:fs";
import type { Worker } from "@playwright/test";
import { BLANK, closeWorkspace, openBlank } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, startFromCapture } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { describeValues, writeValues } from "./fixtures/values.ts";
import { pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const BIG_BYTES = 8 * 1024 * 1024;

interface ManifestGlobal {
  chrome: { runtime: { getManifest: () => Record<string, unknown> } };
}

/** The Chrome version and the manifest WXT built, as the service worker sees them. */
const buildOf = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => {
    const { chrome } = globalThis as unknown as ManifestGlobal;
    const { manifest_version, version, permissions, host_permissions, message_serialization } =
      chrome.runtime.getManifest();
    const manifest = {
      manifest_version,
      version,
      permissions,
      host_permissions,
      message_serialization,
    };
    return { chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1], manifest };
  });

/** The WXT version the lockfile resolved for the extension, which built what this test loads. */
const wxtVersion = () => {
  const lock = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  return /^ {6}wxt:\n {8}specifier: .+\n {8}version: ([\d.]+)/m.exec(lock)?.[1];
};

test("structured values cross app, agent, background, and extension storage by type and content", async ({
  context,
  serviceWorker,
}) => {
  const source = await openBlank(context, serviceWorker);
  await writeValues(source, BIG_BYTES);
  const written = await describeValues(source);
  // The comparison below means something only if the page kept every type to begin with.
  expect(written).toMatchObject({
    date: { type: "Date" },
    blob: { type: "Blob", mime: "text/x-recnrun", text: "hello, blob" },
    buffer: { type: "ArrayBuffer" },
    map: { type: "Map" },
    set: { type: "Set" },
    undefined: { type: "undefined" },
    big: {
      type: "Object",
      entries: [["bytes", { type: "Uint8Array", bytes: { length: BIG_BYTES } }]],
    },
  });
  const capture = await captureIdentity(serviceWorker, "identity-values");
  expect(capture).toMatchObject({ databases: 1, records: 10 });
  await closeWorkspace(serviceWorker, source);

  const restoring = await startFromCapture(serviceWorker, "identity-values");
  const restored = await pageAt(context, BLANK);
  await expect(describeValues(restored)).resolves.toEqual(written);
  await closeWorkspace(serviceWorker, restored);

  await keep("transport-fidelity", {
    build: { ...(await buildOf(serviceWorker)), wxt: wxtVersion() },
    bigRecordBytes: BIG_BYTES,
    captureMs: capture.ms,
    restoreSteps: restoring,
    types: Object.fromEntries(
      Object.entries(written).map(([key, value]) => [key, (value as { type: string }).type]),
    ),
  });
});
