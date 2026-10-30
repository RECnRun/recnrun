import type { Page } from "@playwright/test";

/** One Storage as the page sees it: its size, and which expected keys it does not hold as written. */
interface StorageReport {
  entries: number;
  chars: number;
  mismatched: string[];
}

/**
 * Writes (when `write`) and then checks odd Web Storage entries inside the page: keys named like
 * object properties, an empty key, empty values, unicode, lone surrogates, and large values. The
 * comparison runs in the page because lone surrogates do not survive the trip to the test.
 */
export function webStorageIn(
  page: Page,
  write: boolean,
): Promise<Record<"localStorage" | "sessionStorage", StorageReport>> {
  return page.evaluate((writing) => {
    const odd = (big: number): [string, string][] => [
      ["__proto__", "a"],
      ["constructor", ""],
      ["prototype", "p"],
      ["", "empty key"],
      ["ключ 🔑", "värde 😀"],
      [`lone ${String.fromCharCode(0xd800)}`, String.fromCharCode(0xdfff, 0x41)],
      ["big", "x".repeat(big)],
    ];
    const check = (storage: Storage, expected: [string, string][]) => {
      if (writing) for (const [key, value] of expected) storage.setItem(key, value);
      const mismatched = expected
        .filter(([key, value]) => storage.getItem(key) !== value)
        .map(([key]) => JSON.stringify(key));
      let chars = 0;
      for (let at = 0; at < storage.length; at += 1) {
        const key = storage.key(at) ?? "";
        chars += key.length + (storage.getItem(key) ?? "").length;
      }
      return { entries: storage.length, chars, mismatched };
    };
    return {
      localStorage: check(localStorage, odd(2_000_000)),
      sessionStorage: check(sessionStorage, [...odd(1_000_000), ["tab", "this tab only"]]),
    };
  }, write);
}

/** How many entries each Storage of the page holds. */
export const storageSizes = (page: Page) =>
  page.evaluate(() => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
  }));
