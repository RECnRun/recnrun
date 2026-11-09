// Allowlist match shared by every gate that admits an origin; "*" stands for any http(s) origin.
export const isWebOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return /^https?:$/.test(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
};

export const allows = (list, origin) =>
  isWebOrigin(origin) && (list.includes(origin) || list.includes("*"));
