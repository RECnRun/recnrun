// Valibot schemas implement Standard Schema, so the UI validates with the protocol's schemas without importing Valibot.

type Issue = { readonly message: string };
type Outcome<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly Issue[] };

/** A schema the UI can validate with: any protocol schema, or one built below. */
export type Schema<T> = {
  readonly "~standard": {
    readonly validate: (value: unknown) => Outcome<T> | Promise<Outcome<T>>;
  };
};

export type Output<S> = S extends Schema<infer T> ? T : never;

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** Validates `value` synchronously; every protocol schema is synchronous. */
export function check<T>(schema: Schema<T>, value: unknown): Checked<T> {
  const outcome = schema["~standard"].validate(value);
  if (outcome instanceof Promise) return { ok: false, message: "The schema is asynchronous." };
  if (outcome.issues) {
    return { ok: false, message: outcome.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, value: outcome.value };
}

function schema<T>(validate: (value: unknown) => Outcome<T>): Schema<T> {
  return { "~standard": { validate } };
}

const fail = (message: string): Outcome<never> => ({ issues: [{ message }] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Optional<T> = Schema<T> & { readonly optional: true };
type Entries = Record<string, Schema<unknown>>;
type OptionalKeys<E extends Entries> = {
  [K in keyof E]: E[K] extends { optional: true } ? K : never;
}[keyof E];
type Shape<E extends Entries> = { [K in Exclude<keyof E, OptionalKeys<E>>]: Output<E[K]> } & {
  [K in OptionalKeys<E>]?: Output<E[K]>;
};

/** A key that may be absent; its schema runs only when the key is present. */
export function optional<T>(inner: Schema<T>): Optional<T> {
  return { "~standard": inner["~standard"], optional: true };
}

function checkEntries(entries: Entries, value: Record<string, unknown>): Outcome<unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(entries)) {
    if (value[key] === undefined && "optional" in inner) continue;
    const checked = check(inner, value[key]);
    if (!checked.ok) return fail(`${key}: ${checked.message}`);
    output[key] = checked.value;
  }
  return { value: output };
}

/** An object with these keys; other keys are dropped, so a newer service stays readable. */
export function object<E extends Entries>(entries: E): Schema<Shape<E>> {
  return schema((value) =>
    isRecord(value)
      ? (checkEntries(entries, value) as Outcome<Shape<E>>)
      : fail("Expected an object."),
  );
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return schema<T[]>((value) => {
    if (!Array.isArray(value)) return fail("Expected an array.");
    const output: T[] = [];
    for (const [index, entry] of value.entries()) {
      const checked = check(item, entry);
      if (!checked.ok) return fail(`[${index}]: ${checked.message}`);
      output.push(checked.value);
    }
    return { value: output };
  });
}
