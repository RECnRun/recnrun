import { expect, test } from "vite-plus/test";
import { addressSuggestions, MAX_SUGGESTIONS } from "@/dashboard/address-suggestions";
import type { OpenTab } from "@/ports/tabs";
import { identity } from "./fake-lifecycle";

const tab = (id: number, url: string, title: string, incognito = false): OpenTab => ({
  id,
  windowId: incognito ? 9 : 1,
  incognito,
  title,
  url,
});

const NONE = { tabs: [], identities: [], history: [] };

test("open normal tabs come first, then saved identities, then history, most recent visit first", () => {
  const suggestions = addressSuggestions("", {
    tabs: [tab(1, "https://shop.example/cart", "Cart")],
    identities: [{ ...identity("a"), url: "https://admin.example/" }],
    history: [
      { url: "https://old.example/", title: "Old", lastVisitTime: 1 },
      { url: "https://new.example/", title: "New", lastVisitTime: 5 },
      { url: "https://never.example/", title: "Never" },
    ],
  });
  expect(suggestions).toEqual([
    { url: "https://shop.example/cart", title: "Cart", from: "tab" },
    { url: "https://admin.example/", title: "A", from: "identity" },
    { url: "https://new.example/", title: "New", from: "history" },
    { url: "https://old.example/", title: "Old", from: "history" },
    { url: "https://never.example/", title: "Never", from: "history" },
  ]);
});

test("only http and https addresses of normal tabs, each address once, the first source winning", () => {
  const suggestions = addressSuggestions("", {
    tabs: [
      tab(1, "https://app.example/", "App tab"),
      tab(2, "chrome://settings/", "Settings"),
      tab(3, "https://private.example/", "Private", true),
      tab(4, "https://app.example/", "Same app"),
    ],
    identities: [{ ...identity("a"), url: "https://app.example/" }],
    history: [
      { url: "https://app.example/", title: "App history", lastVisitTime: 9 },
      { url: "file:///etc/hosts", title: "Hosts", lastVisitTime: 8 },
    ],
  });
  expect(suggestions).toEqual([{ url: "https://app.example/", title: "App tab", from: "tab" }]);
});

test("tabs and identities match the typed text in their address or title, ignoring case", () => {
  const sources = {
    ...NONE,
    tabs: [tab(1, "https://shop.example/", "Groceries"), tab(2, "https://docs.example/", "Docs")],
    identities: [{ ...identity("b"), label: "Shop admin", url: "https://admin.example/" }],
  };
  expect(addressSuggestions("  SHOP ", sources).map(({ url }) => url)).toEqual([
    "https://shop.example/",
    "https://admin.example/",
  ]);
  expect(addressSuggestions("groc", sources).map(({ title }) => title)).toEqual(["Groceries"]);
});

test("history keeps Chrome's own matches, since Chrome searched it with the typed text", () => {
  const history = [{ url: "https://found.example/", title: "Found by Chrome", lastVisitTime: 1 }];
  expect(addressSuggestions("zzz", { ...NONE, history })).toHaveLength(1);
});

test("the list stops at its maximum, history first to go", () => {
  const tabs = Array.from({ length: MAX_SUGGESTIONS - 1 }, (_, index) =>
    tab(index + 1, `https://tab${index}.example/`, `Tab ${index}`),
  );
  const history = [
    { url: "https://h1.example/", title: "H1", lastVisitTime: 2 },
    { url: "https://h2.example/", title: "H2", lastVisitTime: 1 },
  ];
  const suggestions = addressSuggestions("", { ...NONE, tabs, history });
  expect(suggestions).toHaveLength(MAX_SUGGESTIONS);
  expect(suggestions.at(-1)).toMatchObject({ url: "https://h1.example/", from: "history" });
});
