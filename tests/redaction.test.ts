import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { hashValue, redact } from "./browser/observer/redact.ts";

// The fixture's session ids and login codes are 16 random bytes in lowercase hex (apps/fixture/src/sessions.ts).
const SID = "0123456789abcdef0123456789abcdef";
const OTHER_SID = "fedcba9876543210fedcba9876543210";
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("hashValue", () => {
  test("is a sha256 prefix and hex digest, stable across calls", () => {
    expect(hashValue("secret")).toBe(sha("secret"));
    expect(hashValue("secret")).toBe(hashValue("secret"));
  });

  test("leaves a value that is already a hash unchanged", () => {
    expect(hashValue(sha("secret"))).toBe(sha("secret"));
  });
});

describe("redact", () => {
  test("hashes the value of every cookie object and keeps its name", () => {
    const cookies = [
      { name: "api_sid", value: SID, domain: "api.localhost", path: "/", httpOnly: true },
      { name: "theme", value: "dark", domain: "app.localhost", path: "/" },
    ];
    expect(redact(cookies)).toEqual([
      { name: "api_sid", value: sha(SID), domain: "api.localhost", path: "/", httpOnly: true },
      { name: "theme", value: sha("dark"), domain: "app.localhost", path: "/" },
    ]);
  });

  test("hashes the cookies a request carried or a response blocked", () => {
    const extraInfo = {
      associatedCookies: [{ blockedReasons: [], cookie: { name: "a", value: "1", path: "/" } }],
      blockedCookies: [{ cookieLine: `api_sid=${SID}; Path=/`, blockedReasons: ["SameSite"] }],
    };
    expect(redact(extraInfo)).toEqual({
      associatedCookies: [
        { blockedReasons: [], cookie: { name: "a", value: sha("1"), path: "/" } },
      ],
      blockedCookies: [{ cookieLine: sha(`api_sid=${SID}; Path=/`), blockedReasons: ["SameSite"] }],
    });
  });

  test("hashes Authorization, Cookie, and Set-Cookie header values in any case", () => {
    const headers = {
      Authorization: "Bearer token-1",
      cookie: `api_sid=${SID}`,
      "Set-Cookie": `idp_sid=${OTHER_SID}; HttpOnly`,
      "content-type": "application/json",
    };
    expect(redact({ headers })).toEqual({
      headers: {
        Authorization: sha("Bearer token-1"),
        cookie: sha(`api_sid=${SID}`),
        "Set-Cookie": sha(`idp_sid=${OTHER_SID}; HttpOnly`),
        "content-type": "application/json",
      },
    });
  });

  test("hashes sensitive header lines in raw header text", () => {
    const headersText = `HTTP/1.1 302 Found\r\nSet-Cookie: api_sid=${SID}; Secure\r\nLocation: /\r\n`;
    expect(redact({ headersText })).toEqual({
      headersText: `HTTP/1.1 302 Found\r\nSet-Cookie: ${sha(`api_sid=${SID}; Secure`)}\r\nLocation: /\r\n`,
    });
  });

  test("hashes idp_sid and api_sid values in URLs and bodies", () => {
    expect(redact("http://x.localhost/?api_sid=tok-en&b=1")).toBe(
      `http://x.localhost/?api_sid=${sha("tok-en")}&b=1`,
    );
    expect(redact({ postData: "idp_sid=abc; other=1" })).toEqual({
      postData: `idp_sid=${sha("abc")}; other=1`,
    });
  });

  test("hashes anything shaped like a fixture session id or login code", () => {
    expect(redact(`/session?code=${SID}&redirect=x`)).toBe(`/session?code=${sha(SID)}&redirect=x`);
    expect(redact({ args: [{ value: `user ${OTHER_SID}` }] })).toEqual({
      args: [{ value: `user ${sha(OTHER_SID)}` }],
    });
  });

  test("keeps Chrome's uppercase ids and existing 64-digit hashes", () => {
    const event = {
      requestId: "3A4F0123456789ABCDEF0123456789AB",
      cookieHash: createHash("sha256").update("x").digest("hex"),
    };
    expect(redact(event)).toEqual(event);
  });

  test("is idempotent", () => {
    const value = {
      headers: { Cookie: `api_sid=${SID}` },
      url: `http://a/?idp_sid=${OTHER_SID}`,
      cookies: [{ name: "n", value: "v", domain: "d" }],
    };
    expect(redact(redact(value))).toEqual(redact(value));
  });

  test("leaves numbers, booleans, and null alone", () => {
    expect(redact({ status: 302, ok: false, body: null })).toEqual({
      status: 302,
      ok: false,
      body: null,
    });
  });
});
