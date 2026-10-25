import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    isolate: false,
    include: ["tests/**/*.test.ts"],
  },
});
