import type { Worker } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import {
  barrierLeft,
  closeTab,
  delayStep,
  failNext,
  incognitoWindows,
  journalOf,
} from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { marked, readMarker, writeMarker } from "./fixtures/markers.ts";
import { storedCaptures, tamperCapture, untamperCapture } from "./fixtures/tamper.ts";
import type { Tamper } from "./fixtures/tamper.ts";
import { managedWindow } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** A holds `A:1` and is saved, B holds `B:1` and is saved, and A is open again holding `A:2`. */
async function bothSaved(context: Parameters<typeof lifecycleSetUp>[0], serviceWorker: Worker) {
  const setup = await lifecycleSetUp(context, serviceWorker);
  const { identities, next } = setup;
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.open("B");
  await writeMarker(await next(), "B:1");
  await identities.open("A");
  const page = await next();
  expect(await readMarker(page)).toEqual(marked("A:1"));
  await writeMarker(page, "A:2");
  return setup;
}

/** Waits until the running operation reached `step`. */
const atStep = (serviceWorker: Worker, step: string) =>
  expect.poll(() => journalOf(serviceWorker)).toMatchObject({ step, status: "running" });

/** No Incognito window is left, nor any barrier rule or script. */
async function nothingLeft(serviceWorker: Worker) {
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  expect(await barrierLeft(serviceWorker)).toEqual({ rules: 0, scripts: 0 });
}

const REFUSED: Record<Tamper, string> = {
  invalid: "A stored capture does not match its schema.",
  incomplete: "The capture must be complete.",
  missing: "The published capture is missing.",
  unpublished: "RECnRun has no saved data for this identity.",
};

test("a missing, invalid, or incomplete capture refuses Resume, opens no window, and is left as it was", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.suspend();
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  const refusals: Record<string, string> = {};
  for (const how of ["invalid", "incomplete", "missing", "unpublished"] as const) {
    await tamperCapture(serviceWorker, identities.idOf("A"), how);
    const refused = await identities.resume("A").then(
      () => "resumed",
      (error: unknown) => String(error),
    );
    expect(refused, how).toContain(REFUSED[how]);
    refusals[how] = refused;
    await nothingLeft(serviceWorker);
    await untamperCapture(serviceWorker);
  }
  await identities.resume("A");
  expect(await readMarker(await next())).toEqual(marked("A:1"));
  await keep("lifecycle-bad-captures", refusals);
});

test("a switch to an identity whose capture is broken saves the open one before it fails", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await bothSaved(context, serviceWorker);
  await tamperCapture(serviceWorker, identities.idOf("B"), "invalid");
  await expect(identities.open("B")).rejects.toThrow(REFUSED.invalid);
  expect(await journalOf(serviceWorker)).toMatchObject({
    step: "start-from-capture",
    status: "failed",
  });
  // The plan sees only that B has a capture, so A closed before B's capture was read.
  await nothingLeft(serviceWorker);
  await untamperCapture(serviceWorker);
  await identities.resume("A");
  expect(await readMarker(await next())).toEqual(marked("A:2"));
});

test("a failed capture, persistence, or restore leaves a state the next command recovers from", async ({
  context,
  serviceWorker,
}) => {
  const { driver, identities, next, tab } = await bothSaved(context, serviceWorker);
  const lastCapture = async () => {
    const status = (await driver.command({ type: "workspace-status" })) as {
      identities: { label: string; lastCapture?: { id: string } }[];
    };
    return status.identities.find(({ label }) => label === "A")?.lastCapture?.id;
  };
  const savedA = await lastCapture();

  for (const step of ["capture", "persist"]) {
    await failNext(serviceWorker, step);
    await expect(identities.open("B")).rejects.toThrow(`The test build failed the ${step} step.`);
    expect(await journalOf(serviceWorker)).toMatchObject({ step, status: "failed" });
    // A's window stays open with its data, and its identity still names the capture it had.
    expect(tab.page?.isClosed()).toBe(false);
    expect(await incognitoWindows(serviceWorker)).toBe(1);
    if (tab.page) expect(await readMarker(tab.page)).toEqual(marked("A:2"));
    expect(await lastCapture()).toBe(savedA);
    // The capture taken before the failure is taken back: A's saved capture is still the published one.
    const idA = identities.idOf("A");
    expect(await storedCaptures(serviceWorker, idA)).toEqual({
      pointer: { identityId: idA, captureId: savedA },
      count: 1,
    });
  }

  await failNext(serviceWorker, "restore");
  await expect(identities.open("B")).rejects.toThrow("The test build failed the restore step.");
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "restore", status: "failed" });
  await nothingLeft(serviceWorker);
  expect(await lastCapture()).not.toBe(savedA);
  await identities.resume("B");
  expect(await readMarker(await next())).toEqual(marked("B:1"));
  await identities.open("A");
  expect(await readMarker(await next())).toEqual(marked("A:2"));
});

test("a tab closed during the capture or the restore fails the command, and the saved identities resume", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await bothSaved(context, serviceWorker);
  const closeManaged = async () => {
    const managed = await managedWindow(serviceWorker);
    if (!managed) throw new Error("No managed window");
    await closeTab(serviceWorker, managed.tabId);
  };

  await delayStep(serviceWorker, "capture", 2_000);
  const capturing = identities.open("B").then(
    () => "switched",
    (error: unknown) => String(error),
  );
  await atStep(serviceWorker, "capture");
  await closeManaged();
  const duringCapture = await capturing;
  expect(duringCapture).not.toBe("switched");
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "capture", status: "failed" });
  await nothingLeft(serviceWorker);
  await delayStep(serviceWorker, "capture", 0);
  // A:2 was never captured, and Incognito discarded it with the window.
  await identities.resume("A");
  expect(await readMarker(await next())).toEqual(marked("A:1"));

  await delayStep(serviceWorker, "restore", 2_000);
  const restoring = identities.open("B").then(
    () => "switched",
    (error: unknown) => String(error),
  );
  await atStep(serviceWorker, "restore");
  await closeManaged();
  expect(await restoring).toContain("The page closed before its data was restored.");
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "restore", status: "failed" });
  await nothingLeft(serviceWorker);
  await delayStep(serviceWorker, "restore", 0);
  await identities.resume("B");
  expect(await readMarker(await next())).toEqual(marked("B:1"));
  await keep("lifecycle-tab-closed", { duringCapture });
});
