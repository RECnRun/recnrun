import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAMESPACE } from "./lab.mjs";
import { launcher } from "./commands-lab.mjs";
import { CLONE, controlScene } from "./clone-control-lab.mjs";
import { life } from "./lifecycle-lab.mjs";

/*
 * The shell half of the browser lab of the dashboard's clone control (tests/browser/clone-control.spec.ts):
 * the controlScene of clone-control.checks.mjs aimed at the Downloads root of a real master, with the
 * real launcher (recnrun-launcher.sh start --once) as the loop. Chrome on the clone is the lab's stub.
 */
export function cloneControlRig({ downloads, masterId }) {
  const cleanups = [];
  const real = { id: masterId, downloads };
  const s = controlScene(
    { after: (cleanup) => cleanups.push(cleanup) },
    { STUB_ALIVE: "600" },
    real,
  );
  const stateFile = join(s.state, "profiles", CLONE);
  // The scene's own cleanup ends only the first profile's Chrome; the clone's is named by its state.
  cleanups.push(() => {
    const named = existsSync(stateFile)
      ? /^pid=(\d+)$/m.exec(readFileSync(stateFile, "utf8"))
      : null;
    if (named) {
      try {
        process.kill(Number(named[1]), "SIGKILL");
      } catch {
        // Already gone is the goal.
      }
    }
  });
  return {
    home: s.home,
    state: s.state,
    record: s.record,
    namespace: NAMESPACE,
    clone: CLONE,
    requestFolder: (id) => join(s.control, id),
    /** One pass of the launcher's loop. */
    pass: (extra = {}) =>
      launcher("sh", ["start", s.state, s.record, NAMESPACE, "--once"], s.vars(extra)),
    /** Holds the clone closed, as the owner's close does, before any pass opens it. */
    hold: () => life("sh", ["close", s.state, s.record, NAMESPACE, CLONE], s.vars()),
    launches: s.launches,
    signals: s.signals,
    field: (key) => s.field(key, CLONE),
    clonesJson: () => readFileSync(join(s.control, "clones.json"), "utf8"),
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup()),
  };
}
