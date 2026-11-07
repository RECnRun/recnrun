import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Node unit tests of the lab harness itself: the observer allowlist, the sample counts, and the W6 envelope.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "harness",
    include: ["*.test.ts", "experiments/*.test.ts", "host/*.test.ts", "lab/web-master/*.test.ts"],
  },
});
