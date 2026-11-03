import { describe, expect, test } from "vite-plus/test";
import { suggestLocators } from "../src/index.ts";

const css = (value: string) => ({ strategy: "css", value });

describe("suggestLocators", () => {
  test("orders testId, role with name, id, name, as an ordered fallback list", () => {
    const target = {
      tag: "input",
      id: "email",
      testId: "email-field",
      name: "email",
      role: "textbox",
      accessibleName: "Email",
    };
    expect(suggestLocators(target)).toEqual({
      resolution: "orderedFallback",
      cardinality: "one",
      locators: [
        { strategy: "testId", value: "email-field" },
        { strategy: "role", role: "textbox", name: "Email", exact: true },
        css("#email"),
        css('input[name="email"]'),
      ],
    });
  });

  test("a role without an accessible name is not a candidate, since it would match many elements", () => {
    expect(suggestLocators({ tag: "div", role: "button", id: "go" }).locators).toEqual([
      css("#go"),
    ]);
  });

  test("ids and names that are not plain identifiers are quoted in attribute selectors", () => {
    expect(suggestLocators({ tag: "input", id: "a:b", name: 'say "hi"' }).locators).toEqual([
      css('[id="a:b"]'),
      css('input[name="say \\"hi\\""]'),
    ]);
  });

  test("falls back to CSS from the tag, type, and role only when nothing identifies the target", () => {
    expect(suggestLocators({ tag: "input", inputType: "checkbox" }).locators).toEqual([
      css('input[type="checkbox"]'),
    ]);
    expect(suggestLocators({ tag: "div", role: "button" }).locators).toEqual([
      css('div[role="button"]'),
    ]);
    expect(suggestLocators({ tag: "li" }).locators).toEqual([css("li")]);
  });
});
