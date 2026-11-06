import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cleanHead, commitMarker } from "../verified-commit.mjs";

const ZERO_SHA = "0".repeat(40);

/** The local commits a push sends, from Git's stdin lines `<local ref> <local sha> <remote ref> <remote sha>`. */
export function pushedCommits(input) {
  const shas = input
    .split("\n")
    .map((line) => line.split(" ")[1])
    // A delete sends the zero sha and pushes no commit.
    .filter((sha) => sha !== undefined && sha !== "" && sha !== ZERO_SHA);
  return [...new Set(shas)];
}

/** Exit status of the hook: every pushed commit needs a marker, or to be the clean HEAD verify can run on now. */
export function prePush(cwd, input) {
  const head = cleanHead(cwd);
  const unverified = [];
  let verifyHead = false;
  for (const sha of pushedCommits(input)) {
    const marker = commitMarker(cwd, sha);
    if (marker) console.log(`Verify already passed on ${sha} (${marker}); not running it again.`);
    else if (sha === head) verifyHead = true;
    else unverified.push(sha);
  }
  for (const sha of unverified) {
    console.error(
      `Commit ${sha} is not verified: check it out with a clean working tree and run \`vp run verify\` there, then push again.`,
    );
  }
  if (unverified.length > 0) return 1;
  if (!verifyHead) return 0;
  const result = spawnSync("vp", ["run", "verify"], { stdio: "inherit" });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Git runs hooks from the top of the working tree, where verify writes its markers.
  process.exit(prePush(process.cwd(), readFileSync(0, "utf8")));
}
