import { defineConfig } from "vite-plus";

// The service's real HTTP and WebSocket paths, in Node; every test forbids non-loopback egress.
export default defineConfig({
  test: {
    name: "contract",
    include: ["*.test.ts"],
    env: { RECNRUN_FORBID_EGRESS: "1" },
    testTimeout: 30_000,
  },
});
