type Visit = (value: unknown) => Promise<unknown>;

/** A copy of `blob` in this context's own blob storage; a File keeps its name and date. */
async function ownCopy(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  return blob instanceof File
    ? new File([bytes], blob.name, { type: blob.type, lastModified: blob.lastModified })
    : new Blob([bytes], { type: blob.type });
}

/** Replaces each child of `container` with what `visit` returns, keeping map and set order. */
async function replaceChildren(container: object, visit: Visit): Promise<void> {
  if (container instanceof Map) {
    const entries = [...container];
    container.clear();
    for (const [key, value] of entries) container.set(await visit(key), await visit(value));
  } else if (container instanceof Set) {
    const items = [...container];
    container.clear();
    for (const item of items) container.add(await visit(item));
  } else if (Array.isArray(container) || Object.getPrototypeOf(container) === Object.prototype) {
    const slots = container as Record<string, unknown>;
    for (const [key, value] of Object.entries(slots)) slots[key] = await visit(value);
  }
}

/**
 * Replaces every Blob that `records` hold, at any depth, with a copy of its own. A Blob that came
 * in a message from an Incognito page reads fine, but the extension's IndexedDB refuses to write
 * it ("Failed to write blobs (InvalidBlob)").
 */
export async function ownBlobs(records: object[]): Promise<void> {
  // A stack, not recursion: clones may nest deeply or refer to themselves.
  const pending = [...records];
  const seen = new Set<object>();
  const visit: Visit = async (value) => {
    if (value instanceof Blob) return ownCopy(value);
    if (typeof value === "object" && value !== null) pending.push(value);
    return value;
  };
  for (let container = pending.pop(); container; container = pending.pop()) {
    if (seen.has(container)) continue;
    seen.add(container);
    await replaceChildren(container, visit);
  }
}
