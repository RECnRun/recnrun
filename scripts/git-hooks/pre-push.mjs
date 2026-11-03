import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifiedMarker } from "../verified-commit.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Git runs hooks from the top of the working tree, where verify writes its marker.
  const marker = verifiedMarker(process.cwd());
  if (marker) {
    console.log(`Verify already passed on this clean commit (${marker}); not running it again.`);
    process.exit(0);
  }
  const result = spawnSync("vp", ["run", "verify"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
