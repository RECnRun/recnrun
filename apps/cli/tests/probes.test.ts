import { expect, test } from "vite-plus/test";
import { openerFor } from "@/probes";

test.each([
  ["darwin", ["open", ["http://127.0.0.1:1/"]]],
  ["linux", ["xdg-open", ["http://127.0.0.1:1/"]]],
  ["win32", ["cmd", ["/c", "start", "", "http://127.0.0.1:1/"]]],
])("the opener on %s is %j", (platform, expected) => {
  expect(openerFor(platform, "http://127.0.0.1:1/")).toEqual(expected);
});
