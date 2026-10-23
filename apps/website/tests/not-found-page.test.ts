import { expect, test, vi } from "vite-plus/test";
import { notFoundPage } from "@build/not-found-page";

async function generate(bundle: object) {
  const plugin = notFoundPage();
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") throw new Error("generateBundle must be a function.");
  const emitFile = vi.fn();
  await hook.call({ emitFile } as never, {} as never, bundle as never, false);
  return emitFile;
}

test("emits 404.html as a copy of the built index.html", async () => {
  const emitFile = await generate({ "index.html": { type: "asset", source: "<div id=app>" } });
  expect(notFoundPage().apply).toBe("build");
  expect(emitFile).toHaveBeenCalledWith({
    type: "asset",
    fileName: "404.html",
    source: "<div id=app>",
  });
});

test("fails the build when there is no index.html to copy", async () => {
  await expect(generate({})).rejects.toThrow("The build produced no index.html.");
});
