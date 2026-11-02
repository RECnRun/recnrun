import { createHash } from "node:crypto";

/**
 * Redaction applied to every value before the observer writes evidence (PLAN.md decision 7).
 * Hashing instead of dropping keeps values comparable across files without exposing them.
 */
const HASHED = /^sha256:[0-9a-f]{64}$/;
// Keys whose whole string value is a credential: request and response headers, blocked cookie lines.
const SENSITIVE_KEYS = new Set(["authorization", "cookie", "set-cookie", "cookieline"]);
const HEADER_LINE = /^(authorization|cookie|set-cookie):[ \t]*([^\r\n]*)/gim;
const SESSION_PARAM = /\b(idp_sid|api_sid)=(?!sha256:)([^;&\s"',]+)/g;
// The fixture's session ids and login codes: 16 random bytes in lowercase hex (apps/fixture/src/sessions.ts).
const SESSION_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;

export function hashValue(value: string): string {
  if (HASHED.test(value)) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redactString(text: string): string {
  return text
    .replace(HEADER_LINE, (_line, name: string, value: string) => `${name}: ${hashValue(value)}`)
    .replace(SESSION_PARAM, (_param, name: string, value: string) => `${name}=${hashValue(value)}`)
    .replace(SESSION_ID, (id) => hashValue(id));
}

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CDP and fixture cookies: a string name and value next to a domain or path. */
function isCookie(value: Json): boolean {
  const named = typeof value.name === "string" && typeof value.value === "string";
  return named && ("domain" in value || "path" in value);
}

function redactEntry(key: string, value: unknown, cookie: boolean): unknown {
  const whole = SENSITIVE_KEYS.has(key.toLowerCase()) || (cookie && key === "value");
  if (whole && typeof value === "string") return hashValue(value);
  return redact(value);
}

/** Returns a copy of `value` with every credential replaced by `sha256:<hex>`; idempotent. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item)) as T;
  if (!isObject(value)) return value;
  const cookie = isCookie(value);
  const entries = Object.entries(value).map(([key, item]) => [key, redactEntry(key, item, cookie)]);
  return Object.fromEntries(entries) as T;
}
