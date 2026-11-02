import { expect, test } from "vite-plus/test";
import { flowFolderLayout } from "../src/index.ts";

test("names the files and folders of a flow folder", () => {
  expect(flowFolderLayout).toEqual({
    flow: "flow.yaml",
    manifest: "manifest.json",
    requirements: "requirements.md",
    datasets: "datasets",
    revisions: "revisions",
    runs: "runs",
  });
});
