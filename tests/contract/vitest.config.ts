import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// The service's real HTTP and WebSocket paths, in Node; every test forbids non-loopback egress.
// Run on its own (`--config`), outside the root projects, so coverage does not run it again.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    name: "contract",
    include: ["*.test.ts"],
    env: { RECNRUN_FORBID_EGRESS: "1" },
    testTimeout: 30_000,
  },
});
