import { installExtension } from "./base-lab.mjs";
import { provisionScene } from "./provision-lab.mjs";

/*
 * The shell half of the browser lab of "Prepare workers" (tests/browser/onboarding.spec.ts): the
 * provisionScene of provision.checks.mjs, aimed at the Downloads root of a real master. Chrome on the
 * base and the clones is the lab's stub, which acks as the real extension would; the base already
 * holds the extension because installBase() writes it into the base, as poc-d0 loaded by hand does.
 */
export function provisionRig({ downloads, namespace }) {
  const cleanups = [];
  const scene = provisionScene(
    { after: (cleanup) => cleanups.push(cleanup) },
    { downloads, namespace },
  );
  return {
    home: scene.home,
    bases: scene.bases,
    record: scene.record,
    state: scene.state,
    folder: scene.folder,
    launchCount: scene.launchCount,
    /** One `provision.sh run`, as the launcher's loop runs it; `extra` is the stub's environment. */
    run: (extra = {}) => scene.run("sh", extra),
    /** The extension in base-v1's profile, so the install step has nothing to do. */
    installBase: () => installExtension(scene.root("base-v1"), { unpacked: true }),
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup()),
  };
}
