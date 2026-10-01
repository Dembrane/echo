import {
  ERROR_CATALOG,
  type ErrorAction,
  type ErrorCode,
  type ErrorParams,
  interpolate,
  type ParamValue,
} from "./catalog";

/** What an error carries besides its code. */
export interface ErrorOptions<C extends ErrorCode> {
  readonly params?: ErrorParams<C>;
  /**
   * The `detail` text when it cannot come from the catalog's template: a message passed
   * through from a library, or a legacy text the parity suite pins. Clients never show it.
   */
  readonly message?: string;
  /** Structured detail when the old API returned an object or a list instead of a string. */
  readonly details?: Record<string, unknown> | readonly unknown[];
}

type HasRequired<P> = { [K in keyof P]-?: undefined extends P[K] ? never : K }[keyof P];

/** Options become required when the code's detail has placeholders to fill. */
export type ErrorArgs<C extends ErrorCode> = [HasRequired<ErrorParams<C>>] extends [never]
  ? [opts?: ErrorOptions<C>]
  : [opts: ErrorOptions<C> & { readonly params: ErrorParams<C> }];

/**
 * The only errors services throw on purpose. Each carries a stable `code` from the catalog
 * (packages/core/src/catalog), the params its message needs and, through the catalog, the
 * action the person can take. One HTTP handler turns them into the response body
 * `{ detail, code, params, action }`; `detail` keeps the old API's text while clients read
 * FastAPI's shape. Anything else thrown becomes a 500 whose details stay in the logs.
 */
export abstract class PlatformError<C extends ErrorCode = ErrorCode> extends Error {
  abstract readonly status: number;
  readonly code: C;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly details?: Record<string, unknown> | readonly unknown[];
  /** Response headers the error carries (Retry-After on a busy lock). */
  readonly headers?: Readonly<Record<string, string>>;
  constructor(code: C, ...[opts]: ErrorArgs<C>) {
    const params = (opts?.params ?? {}) as Readonly<Record<string, ParamValue>>;
    super(opts?.message ?? interpolate(ERROR_CATALOG[code].detail, params));
    this.name = new.target.name;
    this.code = code;
    this.params = params;
    if (opts?.details !== undefined) this.details = opts.details;
  }
  get action(): ErrorAction {
    return ERROR_CATALOG[this.code].action;
  }
}

export class BadRequestError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 400;
}
export class ValidationError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 422;
}
export class UnauthenticatedError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 401;
}
export class PaymentRequiredError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 402;
}
export class ForbiddenError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 403;
}
export class NotFoundError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 404;
}
export class ConflictError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 409;
}
/** 418: the old API answers a tampered invite link with it, and the frontend shows the text. */
export class TamperedRequestError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 418;
}
export class RateLimitedError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 429;
}
export class UnavailableError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status = 503;
}
/** A lock was busy or its store away; nothing was written, and the caller retries in a second. */
export class LockUnavailableError<
  C extends ErrorCode = "internal.busy",
> extends UnavailableError<C> {
  override readonly headers = { "Retry-After": "1" };
}
/**
 * An error with the status the old API chose for it, for the few routes that answered a
 * status no class above names (413, a 500 raised on purpose, a 502 from an upstream).
 */
export class StatusError<C extends ErrorCode = ErrorCode> extends PlatformError<C> {
  readonly status: number;
  constructor(status: number, code: C, ...args: ErrorArgs<C>) {
    super(code, ...args);
    this.status = status;
  }
}

/** The JSON body every error response carries. */
export interface ErrorBody {
  readonly detail: unknown;
  readonly code: ErrorCode;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly action: ErrorAction;
}

export function errorBody(err: PlatformError): ErrorBody {
  return {
    detail: err.details ?? err.message,
    code: err.code,
    params: err.params,
    action: err.action,
  };
}

/** A body for a code thrown by no PlatformError (a framework 404, an unexpected 500). */
export function bodyFor(code: ErrorCode, detail?: unknown): ErrorBody {
  const spec = ERROR_CATALOG[code];
  return { detail: detail ?? spec.detail, code, params: {}, action: spec.action };
}
