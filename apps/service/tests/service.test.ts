import { expect, test } from "vite-plus/test";
import { flowFolderLayout as persistence } from "@recnrun/persistence";
import { createLocalService, createService } from "@/index";

test("reports health with the engine's protocol version", () => {
  const engine = {
    version: 7,
    connect: () => Promise.reject(new Error("unused")),
    disconnect: async () => {},
  };
  expect(createService({ engine, persistence }).health()).toEqual({ ok: true, version: 7 });
});

test("the local service runs the engine at protocol version 1", () => {
  expect(createLocalService().health()).toEqual({ ok: true, version: 1 });
});
