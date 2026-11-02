import { writeFileSync } from "node:fs";
import { CAPABILITY_MATRIX } from "../src/index.ts";
import { renderCapabilitiesMarkdown } from "./render-capabilities.ts";

const target = new URL("../../../docs/CAPABILITIES.md", import.meta.url);
writeFileSync(target, renderCapabilitiesMarkdown(CAPABILITY_MATRIX));
console.log(`Wrote ${CAPABILITY_MATRIX.capabilities.length} capabilities to docs/CAPABILITIES.md.`);
