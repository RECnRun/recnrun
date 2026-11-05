import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The launcher package, built by the developer (POC PLAN.md P4.6), never on the colleague's
 * machine: one folder per OS with the entry point, the shell libraries it sources, the prepared
 * POC extension, a README, and a MANIFEST of SHA-256 sums. Nothing else ships.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const scripts = join(here, "..");
const repository = join(scripts, "../..");
export const POC_BUILD = join(repository, "apps/extension/.output/chrome-mv3-poc-d0");
export const OUT = join(repository, "dist/poc-launcher");
export const LIBRARIES = [
  "recnrun-launcher.sh",
  "first-run.sh",
  "lifecycle.sh",
  "lifecycle-state.sh",
  "lifecycle-launch.sh",
  "open.sh",
  "record.sh",
  "profiles.sh",
  "discovery.sh",
  "autostart.sh",
  "extension-id",
];
const OSES = {
  macos: { name: "macOS", verify: "shasum -a 256 -c MANIFEST" },
  linux: { name: "Linux", verify: "sha256sum -c MANIFEST" },
};

/** Chrome's id of a `key`: the first 16 bytes of the SHA-256 of the DER key, each nibble as a-p. */
export function extensionIdOf(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return Array.from(digest.slice(0, 32), (nibble) =>
    String.fromCharCode(97 + parseInt(nibble, 16)),
  ).join("");
}

/** The parsed manifest of a POC build at `path`; throws unless it is the pinned poc-d0 build. */
export function pocManifest(path) {
  for (const file of ["manifest.json", "diagnostics.html", "bootstrap.html"]) {
    if (!existsSync(join(path, file))) {
      throw new Error(
        `The poc-d0 build has no ${file} at ${path}; run vp run --no-cache extension#build:poc-d0.`,
      );
    }
  }
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  const pinned = readFileSync(join(scripts, "extension-id"), "utf8").split("\n")[0];
  if (typeof manifest.key !== "string" || extensionIdOf(manifest.key) !== pinned) {
    throw new Error(`${path} is not the POC build: its manifest key does not give ${pinned}`);
  }
  if (manifest.permissions?.includes("debugger")) {
    throw new Error(`${path} declares the debugger permission: only poc-d0 is packaged`);
  }
  return manifest;
}

const sorted = (names) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Every file below `directory` as a path relative to `root`, in byte order. */
function filesBelow(directory, root = directory) {
  const found = readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path, root) : [relative(root, path)];
  });
  return sorted(found);
}

function readme(os) {
  const prompts = readFileSync(join(here, `prompts-${os}.md`), "utf8").trimEnd();
  return readFileSync(join(here, "README.md"), "utf8")
    .replace("{{OS}}", OSES[os].name)
    .replace("{{VERIFY}}", OSES[os].verify)
    .replace("{{PROMPTS}}", prompts);
}

function writeFolder(directory, os, extension) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  cpSync(join(here, "recnrun-launcher"), join(directory, "recnrun-launcher"));
  for (const name of LIBRARIES) cpSync(join(scripts, name), join(directory, name));
  cpSync(extension, join(directory, "extension"), { recursive: true });
  writeFileSync(join(directory, "README.md"), readme(os));
  for (const name of ["recnrun-launcher", ...LIBRARIES.filter((it) => it.endsWith(".sh"))]) {
    chmodSync(join(directory, name), 0o755);
  }
  const sums = filesBelow(directory).map((path) => {
    const digest = createHash("sha256")
      .update(readFileSync(join(directory, path)))
      .digest("hex");
    return `${digest}  ${path}\n`;
  });
  writeFileSync(join(directory, "MANIFEST"), sums.join(""));
}

/** Builds `<out>/macos` and `<out>/linux` from the POC build at `extension`; returns the folders. */
export function buildPackage({ extension = POC_BUILD, out = OUT } = {}) {
  pocManifest(extension);
  return Object.keys(OSES).map((os) => {
    const directory = join(out, os);
    writeFolder(directory, os, extension);
    return directory;
  });
}

// Usage: node build.mjs [out-dir]; the build comes from apps/extension/.output/chrome-mv3-poc-d0.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    for (const folder of buildPackage({ out: process.argv[2] ?? OUT })) {
      process.stdout.write(`${folder}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
