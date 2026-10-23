import type { Plugin } from "vite-plus";

/** GitHub Pages answers unknown paths with 404.html, so deep links get the app too. */
export function notFoundPage(): Plugin {
  return {
    name: "recnrun-not-found-page",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (index?.type !== "asset") throw new Error("The build produced no index.html.");
      this.emitFile({ type: "asset", fileName: "404.html", source: index.source });
    },
  };
}
