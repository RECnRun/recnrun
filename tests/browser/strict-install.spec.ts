import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "./fixtures/strict-lab.ts";

/*
 * The strict lab's install (E8): the isolator force-installed by policy into Chrome launched
 * without any remote debugging flag. What says no CDP client exists: the launcher's own argument
 * list, no DevToolsActivePort in the profile, and the isolator's own getTargets() before it armed
 * anything, where an attached target would belong to another client.
 */

const APP = "http://app.localhost:4600";
const PORT_FILE_WAIT_MS = 5_000;

test("strict: the isolator installs by policy into Chrome with no CDP flag and no other client", async ({
  strict,
}) => {
  const { flags, userDataDir } = strict.chrome;
  expect(flags.filter((flag) => flag.includes("remote-debugging"))).toEqual([]);
  await delay(PORT_FILE_WAIT_MS);
  expect(existsSync(join(userDataDir, "DevToolsActivePort"))).toBe(false);
  const [loaded] = strict.sink.loaded;
  expect(loaded?.id).toBe(strict.extensionId);
  expect(loaded?.targets.length).toBeGreaterThan(0);
  expect(loaded?.targets.filter((target) => target.attached)).toEqual([]);
});

test("strict: a rewritten policy reaches the isolator through storage.managed", async ({
  strict,
}) => {
  const written = Date.now();
  await strict.setLab({ stop: { id: "probe", origin: APP } });
  const journal = await strict.sink.until(
    (current) => current.commands.some((command) => command.key === "stop:probe"),
    "the stop command from the rewritten policy",
    60_000,
  );
  test.info().annotations.push({
    type: "policy reload",
    description: `${Date.now() - written} ms from the write to the posted command`,
  });
  // No app worker runs yet, so the stop closes nothing.
  expect(journal.commands).toEqual([{ key: "stop:probe", at: expect.any(Number), result: [] }]);
});
