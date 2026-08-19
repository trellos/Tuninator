/**
 * The one runtime value the public surface exports.
 *
 * `RecognizerError` is a real `Error` subclass, not a plain object: a consumer
 * has to be able to `throw` it, `instanceof` it, and read a stack from it.
 * `start()` and `dispose()` reject with this type and nothing else.
 */

export type RecognizerErrorCode =
  | "mic-unavailable"
  | "mic-permission-denied"
  | "audio-context-failed"
  | "worklet-unavailable"
  | "worklet-load-failed"
  | "engine-load-failed"
  | "already-disposed"
  | "unknown";

export class RecognizerError extends Error {
  readonly code: RecognizerErrorCode;
  override readonly cause?: unknown;

  constructor(code: RecognizerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RecognizerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    // Subclassing a built-in loses the prototype under some downlevel targets.
    Object.setPrototypeOf(this, RecognizerError.prototype);
  }
}

/** Wraps anything thrown by a host API into the one error type we promise. */
export function toRecognizerError(
  error: unknown,
  fallbackCode: RecognizerErrorCode = "unknown"
): RecognizerError {
  if (error instanceof RecognizerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RecognizerError(fallbackCode, message, error);
}
