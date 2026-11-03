import { writeFile } from "node:fs/promises";
import { FREEZE_PATH, hashAssets } from "./assets.ts";

const hashes = await hashAssets();
await writeFile(FREEZE_PATH, `${JSON.stringify(hashes, null, 2)}\n`);
console.log(`Froze ${Object.keys(hashes).length} files into ${FREEZE_PATH}`);
