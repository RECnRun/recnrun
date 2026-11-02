import { expect, test } from "vite-plus/test";
import { createCdpAdapter, NotImplementedError } from "../src/index.ts";

test("connecting is not implemented yet", async () => {
  await expect(createCdpAdapter().connect("ws://127.0.0.1:9222/x")).rejects.toThrow(
    NotImplementedError,
  );
});

test("disconnecting is not implemented yet", async () => {
  await expect(createCdpAdapter().disconnect()).rejects.toThrow(
    "Disconnecting from CDP is not implemented yet.",
  );
});
