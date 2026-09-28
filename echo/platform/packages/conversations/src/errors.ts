import { PlatformError } from "@dembrane/core";

/**
 * A 500 the Python API raised on purpose (HTTPException(500, detail)), whose detail the
 * portal shows. Unlike an unexpected error it carries its text in the body.
 */
export class InternalError extends PlatformError {
  readonly status = 500;
  readonly code = "internal";
}
