import { PlatformError } from "@dembrane/core";

export { PaymentRequiredError } from "@dembrane/legacy-shape";

/** 500 with the old API's text, for states the data should never be in. */
export class InternalError extends PlatformError {
  readonly status = 500;
  readonly code = "internal";
}
