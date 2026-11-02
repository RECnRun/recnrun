import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  INTERPOLATION_NAMESPACES,
  StringWithInterpolationSchema,
  parseInterpolations,
} from "../src/index.ts";

describe("parseInterpolations", () => {
  test("returns every reference with its namespace, path, and position", () => {
    expect(parseInterpolations("${env.baseUrl}/pedidos/${vars.pedido.id}")).toEqual([
      { raw: "${env.baseUrl}", namespace: "env", path: ["baseUrl"], start: 0 },
      { raw: "${vars.pedido.id}", namespace: "vars", path: ["pedido", "id"], start: 23 },
    ]);
  });

  test("returns nothing for plain text", () => {
    expect(parseInterpolations("Aprovado $5 {x}")).toEqual([]);
  });

  test("keeps an unknown namespace so callers can report it", () => {
    expect(parseInterpolations("${process.env}")).toEqual([
      { raw: "${process.env}", namespace: "process", path: ["env"], start: 0 },
    ]);
  });
});

describe("StringWithInterpolationSchema", () => {
  test("allows only the five documented namespaces", () => {
    expect(INTERPOLATION_NAMESPACES).toEqual(["env", "inputs", "vars", "locals", "secrets"]);
  });

  test.each(INTERPOLATION_NAMESPACES.map((namespace) => `x-\${${namespace}.name}-y`))(
    "accepts %s",
    (text) => {
      expect(v.parse(StringWithInterpolationSchema, text)).toBe(text);
    },
  );

  test.each(["${process.env.HOME}", "${window.name}", "${inputs}", "${inputs.}", "${ vars.a }"])(
    "rejects %s",
    (text) => {
      expect(v.safeParse(StringWithInterpolationSchema, text).success).toBe(false);
    },
  );

  test("rejects a value that is not a string", () => {
    expect(v.safeParse(StringWithInterpolationSchema, 1).success).toBe(false);
  });
});
