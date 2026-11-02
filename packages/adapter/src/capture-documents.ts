import * as v from "valibot";

type Emit = (documentId: string | null) => void;

/** Reading the hook in a reused window starts the new document's identity and posts its install. */
export const READ_HOOK_DOCUMENT = "window.__recnrunHook && window.__recnrunHook.documentId";

const ReadSchema = v.object({
  result: v.object({ value: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)) }),
});

/** The document id a `Runtime.evaluate` of `READ_HOOK_DOCUMENT` answered, or null without a hook. */
export function documentRead(reply: unknown): string | null {
  const parsed = v.safeParse(ReadSchema, reply);
  return parsed.success ? parsed.output.result.value : null;
}

/** Bounds a CDP reply, so a renderer that never answers cannot hold events forever. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms.`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The document the hook last reported from each execution context (keyed `<session>:<context>`),
 * and the events held for a context while its document may have changed under the same context.
 */
export class ContextDocuments {
  private readonly known = new Map<string, string>();
  private readonly held = new Map<string, Emit[]>();

  get(key: string): string | null {
    return this.known.get(key) ?? null;
  }

  set(key: string, documentId: string): void {
    this.known.set(key, documentId);
  }

  hold(key: string): void {
    if (!this.held.has(key)) this.held.set(key, []);
  }

  /** Emits with the context's document now, or with the document its hold is released with. */
  emit(key: string, emit: Emit): void {
    const queue = this.held.get(key);
    if (queue) queue.push(emit);
    else emit(this.get(key));
  }

  /** Ends the hold; a known document also becomes the context's document from now on. */
  release(key: string, documentId: string | null): void {
    if (documentId) this.known.set(key, documentId);
    const queue = this.held.get(key);
    this.held.delete(key);
    for (const emit of queue ?? []) emit(documentId);
  }

  /** Releases every hold whose key starts with `prefix`; their document is unknown. */
  releaseAll(prefix = ""): void {
    for (const key of this.held.keys()) if (key.startsWith(prefix)) this.release(key, null);
  }
}
