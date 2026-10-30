/** Settles with the request's result, or rejects with its error. */
export function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.addEventListener("success", () => resolve(target.result));
    target.addEventListener("error", () =>
      reject(target.error ?? new DOMException("Request failed.", "UnknownError")),
    );
  });
}

/**
 * Runs `body` in one transaction and settles after `complete`, so nothing counts as written before
 * it commits; a rejection aborts every write in it. `body` awaits only this transaction's requests.
 */
export function transact<T>(
  connection: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction([...stores], mode);
    let outcome: { value: T } | { error: unknown } | undefined;
    transaction.addEventListener("complete", () => {
      if (outcome && "value" in outcome) resolve(outcome.value);
      else reject(new Error("The transaction committed before its work ended."));
    });
    transaction.addEventListener("abort", () => {
      reject(outcome && "error" in outcome ? outcome.error : transaction.error);
    });
    body(transaction).then(
      (value) => (outcome = { value }),
      (error: unknown) => {
        outcome = { error };
        // A failed request has already aborted the transaction, and aborting twice throws.
        if (transaction.error === null) transaction.abort();
      },
    );
  });
}
