import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Node unit tests of the browser harness itself: evidence redaction and the observer allowlist.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "harness",
    include: ["*.test.ts"],
  },
});
