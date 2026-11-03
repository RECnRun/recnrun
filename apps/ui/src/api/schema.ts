// Valibot schemas implement Standard Schema, so the UI validates with the protocol's schemas without importing Valibot.

type Issue = { readonly message: string };
type Outcome<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly Issue[] };

/** A schema the UI can validate with: any protocol schema. */
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
