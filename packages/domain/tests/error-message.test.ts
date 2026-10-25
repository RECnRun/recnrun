import { expect, test } from "vite-plus/test";
import { errorMessage } from "../src/index.ts";

test("an Error reads as its message", () => {
  expect(errorMessage(new Error("Quota exceeded"))).toBe("Quota exceeded");
  expect(errorMessage(new TypeError("Extension context invalidated."))).toBe(
    "Extension context invalidated.",
  );
});

test("anything else a promise rejects with reads as text", () => {
  expect(errorMessage("Stored session is invalid")).toBe("Stored session is invalid");
  expect(errorMessage(42)).toBe("42");
  expect(errorMessage(undefined)).toBe("undefined");
  expect(errorMessage({ code: 7 })).toBe("[object Object]");
});
