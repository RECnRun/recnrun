import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Node unit tests of the lab harness itself: the observer allowlist and the sample counts.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "harness",
    include: ["*.test.ts"],
  },
});
