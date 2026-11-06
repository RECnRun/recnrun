import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionScene } from "./provision-lab.mjs";

const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/*
 * The shell half of the browser lab of "Prepare workers" (tests/browser/onboarding.spec.ts): the
 * provisionScene of provision.checks.mjs, aimed at the Downloads root of a real master. Chrome on the
 * base and the clones is the lab's stub, which acks as the real extension would; the install step
 * runs install.sh on the real Chrome (realChrome), which loads the build over the DevTools pipe.
 */
export function provisionRig({ downloads, namespace }) {
  const cleanups = [];
  const scene = provisionScene(
    { after: (cleanup) => cleanups.push(cleanup) },
    { downloads, namespace },
  );
  const chrome = join(scene.home, APP);
  const stub = readFileSync(chrome, "utf8");
  const put = (text) => {
    // A rename replaces a stub that may still be running.
    writeFileSync(`${chrome}.next`, text);
    chmodSync(`${chrome}.next`, 0o755);
    renameSync(`${chrome}.next`, chrome);
  };
  return {
    home: scene.home,
    bases: scene.bases,
    record: scene.record,
    state: scene.state,
    folder: scene.folder,
    launchCount: scene.launchCount,
    /** One `provision.sh run`, as the launcher's loop runs it; `extra` is the stub's environment. */
    run: (extra = {}) => scene.run("sh", extra),
    /** The script that stands for Chrome from now on: a wrapper of the real one, or the stub again. */
    realChrome: (script) => put(script),
    stubChrome: () => put(stub),
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup()),
  };
}
