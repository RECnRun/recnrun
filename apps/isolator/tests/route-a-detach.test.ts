import { describe, expect, test } from "vite-plus/test";
import type { Debuggee } from "@/background/probes/types";
import { TAB, setup } from "./route-a-setup";

type Fake = ReturnType<typeof setup>;

/** What Chrome does when the user, DevTools, or the target ends the extension's session. */
function detach({ onDetach }: Fake, source: Debuggee, reason: string): void {
  onDetach.set.forEach((listener) => listener(source, reason));
}

describe("Route A detaches", () => {
  test("records the armed tab's own detach with Chrome's reason", async () => {
    const fake = setup();
    await fake.engine.arm({ tabId: TAB });
    detach(fake, { tabId: TAB }, "canceled_by_user");
    expect((await fake.engine.journal()).tabDetached).toEqual({
      reason: "canceled_by_user",
      at: 5,
    });
  });

  test("records a direct target's detach on its journal entry", async () => {
    const fake = setup();
    await fake.engine.attachTarget({ targetId: "shared" });
    detach(fake, { targetId: "shared" }, "replaced_with_devtools");
    const journal = await fake.engine.journal();
    expect(journal.entries.map((entry) => [entry.targetId, entry.detached])).toEqual([
      ["shared", { reason: "replaced_with_devtools", at: 15 }],
    ]);
    expect(journal.tabDetached).toBeUndefined();
  });

  test("ignores detaches of tabs and targets it does not hold", async () => {
    const fake = setup();
    await fake.engine.arm({ tabId: TAB });
    await fake.engine.attachTarget({ targetId: "shared" });
    detach(fake, { tabId: TAB + 1 }, "target_closed");
    detach(fake, { targetId: "elsewhere" }, "target_closed");
    const journal = await fake.engine.journal();
    expect([journal.tabDetached, journal.entries[0]?.detached]).toEqual([undefined, undefined]);
  });

  test("disarm returns the detach and clears it, with one listener across arms", async () => {
    const fake = setup();
    await fake.engine.arm({ tabId: TAB });
    detach(fake, { tabId: TAB }, "canceled_by_user");
    const disarmed = await fake.engine.disarm({ tabId: TAB });
    await fake.engine.arm({ tabId: TAB });
    expect(disarmed.tabDetached?.reason).toBe("canceled_by_user");
    expect((await fake.engine.journal()).tabDetached).toBeUndefined();
    expect(fake.onDetach.set.size).toBe(1);
  });
});
