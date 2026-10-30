const RECORDABLE_PROTOCOLS = new Set(["http:", "https:"]);

function parse(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The host permission pattern that covers a page on every port, or none for unrecordable pages. */
export function originPattern(url: string | undefined): string | undefined {
  const parsed = parse(url);
  if (!parsed || !RECORDABLE_PROTOCOLS.has(parsed.protocol)) return undefined;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function originOf(url: string | undefined): string | undefined {
  return parse(url)?.origin;
}

/** Whether a page URL is covered by one of the manifest's `scheme://host/*` patterns. */
export function urlMatches(url: string | undefined, patterns: readonly string[]): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  return patterns.some((pattern) => {
    const [scheme, rest] = pattern.split("://");
    const host = rest?.split("/")[0];
    return host !== undefined && `${scheme}:` === parsed.protocol && host === parsed.hostname;
  });
}
