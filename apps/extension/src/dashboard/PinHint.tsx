import { useEffect, useState } from "preact/hooks";
import type { ToolbarPin } from "@/ports/toolbar";

/** Whether RECnRun is on the toolbar; `undefined` until Chrome answers, or when it cannot. */
function usePinned(pin: ToolbarPin): boolean | undefined {
  const [pinned, setPinned] = useState<boolean>();
  useEffect(() => {
    void pin.pinned().then(setPinned, () => setPinned(undefined));
    return pin.watch(setPinned);
  }, [pin]);
  return pinned;
}

/** Asks the user to pin RECnRun, since Chrome lets only them put its icon on the toolbar. */
export function PinHint({ pin }: { pin: ToolbarPin }) {
  if (usePinned(pin) !== false) return null;
  return (
    <section class="pin-hint" aria-labelledby="pin-heading">
      <h3 id="pin-heading">Pin RECnRun to the toolbar</h3>
      <p>
        Open the Extensions menu, the puzzle piece next to the address bar, and pin RECnRun: its
        icon then opens this dashboard in one click.
      </p>
    </section>
  );
}
