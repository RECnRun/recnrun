/** A failed command: the service's error code, or `unreachable` and `invalid-response` from the client. */
export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** Wraps anything a command threw so every screen shows a code and a message. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("internal", error instanceof Error ? error.message : String(error));
}
