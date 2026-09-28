/**
 * The only errors services throw on purpose. One HTTP handler maps them to the response
 * body; anything else becomes a 500 whose details stay in the logs. While the frontend
 * reads FastAPI's `{ detail }` shape, the body is `{ detail: details ?? message }`.
 */
export abstract class PlatformError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  /** Response headers the error carries (Retry-After on a busy lock). */
  readonly headers?: Readonly<Record<string, string>>;
  constructor(
    message: string,
    /** Structured detail when the old API returned an object or a list instead of a string. */
    readonly details?: Record<string, unknown> | readonly unknown[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends PlatformError {
  readonly status = 400;
  readonly code = "bad_request";
}
export class ValidationError extends PlatformError {
  readonly status = 422;
  readonly code = "validation_failed";
}
export class UnauthenticatedError extends PlatformError {
  readonly status = 401;
  readonly code = "unauthenticated";
}
export class PaymentRequiredError extends PlatformError {
  readonly status = 402;
  readonly code = "payment_required";
}
export class ForbiddenError extends PlatformError {
  readonly status = 403;
  readonly code = "forbidden";
}
export class NotFoundError extends PlatformError {
  readonly status = 404;
  readonly code = "not_found";
}
export class ConflictError extends PlatformError {
  readonly status = 409;
  readonly code = "conflict";
}
/** 418: the old API answers a tampered invite link with it, and the frontend shows the text. */
export class TamperedRequestError extends PlatformError {
  readonly status = 418;
  readonly code = "tampered";
}
export class RateLimitedError extends PlatformError {
  readonly status = 429;
  readonly code = "rate_limited";
}
export class UnavailableError extends PlatformError {
  readonly status = 503;
  readonly code = "unavailable";
}
/** A lock was busy or its store away; nothing was written, and the caller retries in a second. */
export class LockUnavailableError extends UnavailableError {
  override readonly headers = { "Retry-After": "1" };
}
