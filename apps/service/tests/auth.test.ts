import { expect, test } from "vite-plus/test";
import { authorize, isAllowedHost, isAllowedOrigin, presentedToken, tokenMatches } from "@/auth";

const token = "k".repeat(43);
const guard = { port: 4700, token };

test.each([
  ["127.0.0.1:4700", true],
  ["localhost:4700", true],
  ["LOCALHOST:4700", true],
  ["127.0.0.1:4701", false],
  ["127.0.0.1", false],
  ["evil.example:4700", false],
  ["[::1]:4700", false],
  [undefined, false],
])("Host %s allowed: %s", (host, allowed) => {
  expect(isAllowedHost(host, 4700)).toBe(allowed);
});

test.each([
  [undefined, true],
  ["http://127.0.0.1:4700", true],
  ["http://localhost:4700", true],
  ["https://127.0.0.1:4700", false],
  ["http://127.0.0.1:4701", false],
  ["http://localhost.evil.example:4700", false],
  ["null", false],
])("Origin %s allowed: %s", (origin, allowed) => {
  expect(isAllowedOrigin(origin, 4700)).toBe(allowed);
});

test("reads the bearer header, and the query only where allowed", () => {
  expect(presentedToken({ authorization: `Bearer ${token}` }, "/api", false)).toBe(token);
  expect(presentedToken({ authorization: `bearer  ${token}` }, "/api", false)).toBe(token);
  expect(presentedToken({}, `/ws?token=${token}`, false)).toBeUndefined();
  expect(presentedToken({}, `/ws?token=${token}`, true)).toBe(token);
  expect(presentedToken({ authorization: "Basic abc" }, "/ws", true)).toBeUndefined();
});

test("compares tokens of any length without throwing", () => {
  expect(tokenMatches(token, token)).toBe(true);
  expect(tokenMatches("short", token)).toBe(false);
  expect(tokenMatches(undefined, token)).toBe(false);
});

test("checks Host and Origin (403) before the token (401)", () => {
  const host = "127.0.0.1:4700";
  expect(authorize({ headers: { host, authorization: `Bearer ${token}` } }, guard, false)).toEqual({
    ok: true,
  });
  expect(authorize({ headers: { host } }, guard, false)).toMatchObject({ status: 401 });
  expect(authorize({ headers: { host: "evil.example:4700" } }, guard, false)).toMatchObject({
    status: 403,
    message: "Host is not this service.",
  });
  expect(
    authorize({ headers: { host, origin: "https://evil.example" } }, guard, false),
  ).toMatchObject({ status: 403, code: "forbidden", message: "Origin is not allowed." });
});
