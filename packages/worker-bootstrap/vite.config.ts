import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import type { Plugin } from "vite-plus";
import { BUNDLE_NAME, MODULE_TYPES, renderArtifact, renderModule } from "./src/artifact.ts";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Emits dist/bootstrap.js (and its types), the module that carries BOOTSTRAP_SOURCE. */
function bootstrapModule(): Plugin {
  return {
    name: "recnrun-bootstrap-module",
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((output) => output.type === "chunk");
      if (entry?.type !== "chunk") throw new Error("The bootstrap build produced no chunk.");
      const artifact = renderArtifact(entry.code, version);
      this.emitFile({ type: "asset", fileName: "bootstrap.js", source: renderModule(artifact) });
      this.emitFile({ type: "asset", fileName: "bootstrap.d.ts", source: MODULE_TYPES });
    },
  };
}

export default defineConfig({
  plugins: [bootstrapModule()],
  build: {
    outDir: "dist",
    // Readable in a worker's sources panel; the size is a few kilobytes either way.
    minify: false,
    lib: {
      entry: "src/entrypoints/bootstrap.ts",
      formats: ["iife"],
      name: BUNDLE_NAME,
      fileName: () => "bootstrap.iife.js",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
