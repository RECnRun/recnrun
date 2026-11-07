// Canonical JSON and UTF-8 byte arithmetic: every cap of plan §6 is a cap in bytes.
const encoder = new TextEncoder();

export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const utf8Length = (text) => encoder.encode(text).length;

/** The longest prefix of `text` that fits `maxBytes` of UTF-8, never splitting a code point. */
export const truncateUtf8 = (text, maxBytes) => {
  // A prefix of maxBytes UTF-16 units already holds at least maxBytes bytes.
  const head = text.slice(0, maxBytes);
  let used = 0;
  let end = 0;
  for (const char of head) {
    used += utf8Length(char);
    if (used > maxBytes) break;
    end += char.length;
  }
  return head.slice(0, end);
};
